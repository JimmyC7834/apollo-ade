// SPIKE — see docs/wayfinder/pi-harness/tickets/06-credentials-and-http.md.
//
// Rust makes the provider HTTPS call so the API key never enters JavaScript.
// The renderer sends a request with no credential on it; the key is attached
// here and the response is streamed back over a Tauri channel.
//
// Two things this buys beyond secrecy. There is no Node process in a packaged
// build, so a shipped app has nowhere else to make this call from. And a
// request issued from Rust carries no browser origin, so CORS preflight — and
// the `dangerouslyAllowBrowser` escape hatch pi otherwise needs — stops
// applying at all.

use std::collections::HashMap;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// How one provider expects its credential presented.
///
/// The three bundled API shapes disagree on both the header name and the
/// format, so this cannot be one string. Kept as a plain match rather than a
/// registry: three arms is not a lookup problem, and a table would need
/// registration code that does nothing a `match` does not.
struct Credential {
    header: &'static str,
    env_var: &'static str,
    /// Anthropic and Google want the bare key; OpenAI-shaped APIs want a
    /// `Bearer` prefix. Getting this wrong reads as an invalid key.
    bearer: bool,
    /// **The only host this key may be sent to.**
    ///
    /// A field on the credential rather than a table beside it, so a provider
    /// cannot be added without naming where its key travels — the same argument
    /// `CREDENTIAL_VARS` makes about `env_var`, and for the same reason: the
    /// wrong direction for that mistake to fail is silently.
    ///
    /// `src/agent/rustFetch.ts` has the same three hosts, and the duplication is
    /// deliberate in the way `may_write` and `agent_may_write` are. That map is
    /// *routing* — which requests the renderer diverts to Rust at all. This is
    /// the floor: the renderer picks both the provider and the URL, so a
    /// renderer that has been talked into naming another host still cannot make
    /// this process attach a key to it.
    host: &'static str,
}

/// Every environment variable that holds a key, for `exec` to strip.
///
/// Lives here rather than in `exec.rs` because this is the module that decides
/// what a credential *is*; a provider added below without being added here
/// would leak silently, which is the wrong direction for that mistake to fail.
/// The list is the `env_var` field of every arm of `credential_for`.
pub const CREDENTIAL_VARS: [&str; 3] =
    ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"];

/// The credential for a provider, or `None` when there is no such provider.
///
/// **`None` rather than a catch-all**, which is what the last arm used to be:
/// every unrecognised id fell through to the DeepSeek key. Combined with a URL
/// the renderer also chooses, that made `provider_stream` a way to attach a real
/// credential to an arbitrary request — the exact shape of hole `agent_write_file`
/// exists to close on the file surface. The three ids here are `ProviderId` in
/// `src/agent/profile.ts`; a fourth is a change in both places, deliberately.
fn credential_for(provider: &str) -> Option<Credential> {
    match provider {
        "anthropic" => Some(Credential {
            header: "x-api-key",
            env_var: "ANTHROPIC_API_KEY",
            bearer: false,
            host: "api.anthropic.com",
        }),
        "google" => Some(Credential {
            header: "x-goog-api-key",
            env_var: "GEMINI_API_KEY",
            bearer: false,
            host: "generativelanguage.googleapis.com",
        }),
        // OpenAI-shaped, which for this app means DeepSeek. Named rather than
        // matched by default: "every OpenAI-compatible provider" was a promise
        // this app never made — nothing constructs a fourth provider id — and
        // keeping it as a fallback meant a typo in a profile silently sent the
        // DeepSeek key somewhere.
        "deepseek" => Some(Credential {
            header: "authorization",
            env_var: "DEEPSEEK_API_KEY",
            bearer: true,
            host: "api.deepseek.com",
        }),
        _ => None,
    }
}

/// The request URL, if this credential may be sent to it.
///
/// Two conditions, and the scheme is not a formality: without it `http://` to
/// the right host would put the key on the wire in clear.
///
/// Split out from `stream_inner` so it can be asserted below — the rest of that
/// function needs a live `Channel` and a network, and a boundary that can only
/// be tested by crossing it is a boundary nobody tests.
fn permitted(credential: &Credential, url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("not a URL: {url}"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some(credential.host) {
        return Err(format!(
            "refusing to send the {} credential to {url} — it belongs to https://{}",
            credential.env_var, credential.host
        ));
    }
    Ok(parsed)
}

/// Where the key comes from. Ticket 06 settled: environment variable for the
/// spike, OS keychain (`keyring`) for v1. The swap is this function.
fn resolve_api_key(env_var: &str) -> Option<String> {
    std::env::var(env_var).ok().filter(|key| !key.trim().is_empty())
}

#[derive(Deserialize)]
pub struct ProviderRequest {
    /// pi's provider id. Chooses which credential is attached — the renderer
    /// names the provider, never the key.
    provider: String,
    url: String,
    /// Whatever the SDK asked for. Hardcoding POST worked only because every
    /// provider request so far happened to be one.
    method: String,
    /// Sent by the renderer without any credential. The auth header is added
    /// here; anything the renderer sends under that name is discarded rather
    /// than merged, so the renderer cannot influence what key is used.
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderEvent {
    Head {
        status: u16,
        headers: HashMap<String, String>,
    },
    /*
     * Raw bytes, not a string. SSE is text, but a chunk boundary can land in
     * the middle of a multi-byte character, and decoding per chunk would
     * corrupt it. Reassembly belongs to whoever sees the whole stream, so the
     * renderer decodes.
     *
     * The cost is that serde renders this as a JSON array of numbers, which is
     * several times the size of the payload. Acceptable while the question is
     * whether streaming works at all; if throughput ever matters, this is the
     * thing to change.
     */
    Chunk {
        bytes: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

/// Stream a provider response back to the renderer.
///
/// Never returns `Err` for transport failures — they are delivered as an
/// `Error` event instead. A rejected `invoke` would surface in the renderer as
/// a thrown promise somewhere inside pi's stream plumbing, which is exactly the
/// shape of failure the never-throw contract exists to avoid.
#[tauri::command]
pub async fn provider_stream(request: ProviderRequest, on_event: Channel<ProviderEvent>) {
    if let Err(message) = stream_inner(request, &on_event).await {
        let _ = on_event.send(ProviderEvent::Error { message });
    }
}

async fn stream_inner(
    request: ProviderRequest,
    on_event: &Channel<ProviderEvent>,
) -> Result<(), String> {
    let credential = credential_for(&request.provider)
        .ok_or_else(|| format!("no credential configured for provider `{}`", request.provider))?;
    // Before the key is even read: the renderer names the provider *and* the
    // URL, and only one of those was ever checked against the other.
    let url = permitted(&credential, &request.url)?;
    let key = resolve_api_key(credential.env_var).ok_or_else(|| {
        format!("{} is not set in the app's environment", credential.env_var)
    })?;

    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| format!("unsupported HTTP method `{}`", request.method))?;

    let client = reqwest::Client::new();
    let mut builder = client.request(method, url).header(
        credential.header,
        if credential.bearer { format!("Bearer {key}") } else { key },
    );

    for (name, value) in &request.headers {
        // Drop anything that would collide with the credential we just set.
        // Checked against every known auth header rather than only this
        // provider's, so a renderer-supplied `x-api-key` cannot ride along on a
        // DeepSeek request.
        if ["authorization", "x-api-key", "x-goog-api-key"]
            .iter()
            .any(|reserved| name.eq_ignore_ascii_case(reserved))
        {
            continue;
        }
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(|error| error.to_string())?;

    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();

    // The head goes out before the first chunk so the renderer can construct a
    // Response and let its consumer start reading. A non-2xx status still
    // streams its body — provider error payloads are JSON worth surfacing.
    on_event
        .send(ProviderEvent::Head { status, headers })
        .map_err(|error| error.to_string())?;

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        on_event
            .send(ProviderEvent::Chunk { bytes: chunk.to_vec() })
            .map_err(|error| error.to_string())?;
    }

    on_event.send(ProviderEvent::End).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{credential_for, permitted, CREDENTIAL_VARS};

    /// Every provider this app can name has a credential, and nothing else does.
    ///
    /// The second half is the one that matters. The last arm used to be `_`, so
    /// any string at all resolved to the DeepSeek key — and the renderer supplies
    /// that string.
    #[test]
    fn only_the_three_providers_have_a_credential() {
        for id in ["deepseek", "anthropic", "google"] {
            assert!(credential_for(id).is_some(), "{id} should have one");
        }
        for id in ["", "openai", "deepseek ", "DeepSeek", "../deepseek", "evil"] {
            assert!(credential_for(id).is_none(), "{id:?} should not have one");
        }
    }

    /// The list `exec.rs` strips is the `env_var` of every arm, and stays that way.
    #[test]
    fn every_credential_is_stripped_from_children() {
        for id in ["deepseek", "anthropic", "google"] {
            let credential = credential_for(id).unwrap();
            assert!(
                CREDENTIAL_VARS.contains(&credential.env_var),
                "{} is not in CREDENTIAL_VARS, so `agent_exec` would leak it",
                credential.env_var
            );
        }
    }

    /// A key goes to its own provider's host over TLS, and nowhere else.
    #[test]
    fn a_key_only_travels_to_its_own_host() {
        let deepseek = credential_for("deepseek").unwrap();
        let anthropic = credential_for("anthropic").unwrap();

        assert!(permitted(&deepseek, "https://api.deepseek.com/chat/completions").is_ok());
        assert!(permitted(&anthropic, "https://api.anthropic.com/v1/messages").is_ok());

        for refused in [
            // The plain exfiltration: a host of the renderer's choosing.
            "https://evil.example/collect",
            // The other provider's host — a key is not merely "for an API".
            "https://api.anthropic.com/v1/messages",
            // Clear text to the right host still puts the key on the wire.
            "http://api.deepseek.com/chat/completions",
            // Host-matching that is a substring test rather than a host test.
            "https://api.deepseek.com.evil.example/x",
            "https://evil.example/?api.deepseek.com",
            // Credentials in the authority, which some parsers read as the host.
            "https://api.deepseek.com@evil.example/x",
            "not a url at all",
            "",
        ] {
            assert!(
                permitted(&deepseek, refused).is_err(),
                "should have refused {refused:?}"
            );
        }
    }
}
