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
}

fn credential_for(provider: &str) -> Option<Credential> {
    match provider {
        "anthropic" => Some(Credential {
            header: "x-api-key",
            env_var: "ANTHROPIC_API_KEY",
            bearer: false,
        }),
        "google" => Some(Credential {
            header: "x-goog-api-key",
            env_var: "GEMINI_API_KEY",
            bearer: false,
        }),
        // Every OpenAI-compatible provider, DeepSeek included.
        _ => Some(Credential {
            header: "authorization",
            env_var: "DEEPSEEK_API_KEY",
            bearer: true,
        }),
    }
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
    let key = resolve_api_key(credential.env_var).ok_or_else(|| {
        format!("{} is not set in the app's environment", credential.env_var)
    })?;

    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| format!("unsupported HTTP method `{}`", request.method))?;

    let client = reqwest::Client::new();
    let mut builder = client.request(method, &request.url).header(
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
