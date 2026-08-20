// A browser tab is a child webview, and this is the whole of the native half.
//
// See docs/adr/0004-a-browser-tab-is-a-child-webview.md. The short version: the
// ADE runs on `tauri://localhost` and a dev server on `http://localhost:5173`,
// so an `<iframe>` would show a page and refuse `contentDocument`. A child
// webview has no such limit — `eval_with_callback` evaluates JavaScript on any
// page and hands the JSON back to Rust — and that one call is the entire
// mechanism for reading the DOM, clicking, typing and reading the console.
//
// There is no `hide` here on purpose. A tab is hidden by being *positioned
// outside the parent's client rect*, where the OS clips it but the page is
// still sized and still lays out. `hide()` would be a second mechanism, and a
// webview that is never shown is exactly the thing this repo has been bitten by
// before — `CONTEXT.md` records the dev browser pane serving no animation
// frames, so Monaco never laid out.

use serde::Serialize;
use tauri::{
    LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview, WebviewBuilder, WebviewUrl,
    Window,
};

/// How long an evaluation may take before the caller is told it failed.
const EVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Emitted when a page sends the ADE a message through the navigation channel.
const MESSAGE_EVENT: &str = "browser://message";
/// Emitted when a page tried to navigate somewhere the allow-list refuses.
const REFUSED_EVENT: &str = "browser://refused";

/**
 * The one-way channel from the page back to us.
 *
 * A child webview pointed at a foreign origin has no Tauri IPC, and giving it
 * one would mean a capability naming a remote domain. It does not need one: a
 * navigation to an unknown scheme reaches `on_navigation`, which refuses it and
 * keeps the path. That handler has to exist anyway to enforce the allow-list on
 * links the page follows, so the channel is free.
 */
const IPC_SCHEME: &str = "ade-ipc";

#[derive(Clone, Serialize)]
struct Message {
    label: String,
    message: String,
}

#[derive(Clone, Serialize)]
struct Refused {
    label: String,
    url: String,
    reason: String,
}

/**
 * Every page runs this before its own scripts.
 *
 * Two jobs, and both are here rather than in the tool because they have to be
 * installed before the page can do anything: Escape hands focus back to the
 * ADE, and `console` is captured into an array the agent can read later. A
 * console the agent asks for after the fact cannot be recovered any other way —
 * by the time a tool call arrives, the message has been printed and lost.
 */
const INIT_SCRIPT: &str = r#"
(() => {
  const send = (message) => {
    try { window.location.href = 'ade-ipc:' + message; } catch (error) { /* refused, as intended */ }
  };
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { send('esc'); }
  }, true);

  const log = [];
  window.__adeConsole = log;
  const say = (level, args) => {
    const text = Array.prototype.map
      .call(args, (value) => {
        if (typeof value === 'string') { return value; }
        try { return JSON.stringify(value); } catch (error) { return String(value); }
      })
      .join(' ');
    log.push(level + ': ' + text);
    // Bounded, because a page in a render loop would otherwise grow it forever.
    if (log.length > 200) { log.shift(); }
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = function () { say(level, arguments); return original.apply(null, arguments); };
  }
  window.addEventListener('error', (event) => say('error', [event.message]));
  window.addEventListener('unhandledrejection', (event) => say('error', ['unhandled rejection: ' + event.reason]));
})();
"#;

/**
 * Which pages a browser tab may open.
 *
 * Localhost and `file:` and nothing else, which is the scope the grill settled.
 * It lives here rather than in the UI that supplies the URL because this is the
 * point the URL is *used*: the address row, the agent's tool and a link the
 * page itself follows all arrive here, and only one of them is ours.
 *
 * Widening it to the public web is recorded as future work in the map, and it
 * is a bigger decision than a longer list — see the deferred entry.
 */
pub fn check(url: &Url) -> Result<(), String> {
    match url.scheme() {
        "file" => Ok(()),
        "http" | "https" => match url.host_str() {
            Some("localhost") | Some("127.0.0.1") | Some("::1") | Some("[::1]") => Ok(()),
            Some(host) => Err(format!(
                "{host} is not a host a browser tab may open. Only localhost and file: URLs are allowed."
            )),
            None => Err("that URL names no host".to_string()),
        },
        scheme => Err(format!(
            "{scheme}: is not a scheme a browser tab may open. Only http, https and file: are allowed."
        )),
    }
}

/// Parse and check in one step, so no caller can do one without the other.
fn resolve(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| format!("{raw} is not a URL: {error}"))?;
    check(&url)?;
    Ok(url)
}

fn find<R: Runtime>(window: &Window<R>, label: &str) -> Result<Webview<R>, String> {
    window
        .app_handle()
        .get_webview(label)
        .ok_or_else(|| format!("there is no browser tab called {label}"))
}

/**
 * Open a tab at a rectangle, in logical pixels relative to the window's client
 * area — the same coordinates `getBoundingClientRect` gives the caller.
 *
 * **Every command in this file that touches a webview is `async`, and that is
 * not decoration.** Tauri runs a synchronous command on the main thread, and
 * `Window::add_child` posts work *to* the main thread and then blocks waiting
 * for it — so a synchronous version deadlocks the whole application on the
 * first call. Found by doing it.
 *
 * Opening a label that already exists navigates it instead. Two webviews with
 * one label is an error in Tauri, and the caller re-mounting a React component
 * must not be one.
 */
#[tauri::command]
pub async fn browser_open<R: Runtime>(
    window: Window<R>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let target = resolve(&url)?;
    if let Ok(existing) = find(&window, &label) {
        existing.navigate(target).map_err(|error| error.to_string())?;
        return browser_place(window, label, x, y, width, height).await;
    }

    let app = window.app_handle().clone();
    let owner = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .initialization_script(INIT_SCRIPT)
        .on_navigation(move |url| {
            if url.scheme() == IPC_SCHEME {
                let _ = tauri::Emitter::emit(
                    &app,
                    MESSAGE_EVENT,
                    Message {
                        label: owner.clone(),
                        // `ade-ipc:esc` parses as an opaque path, which is the message.
                        message: url.path().to_string(),
                    },
                );
                return false;
            }
            match check(url) {
                Ok(()) => true,
                Err(reason) => {
                    let _ = tauri::Emitter::emit(
                        &app,
                        REFUSED_EVENT,
                        Refused {
                            label: owner.clone(),
                            url: url.to_string(),
                            reason,
                        },
                    );
                    false
                }
            }
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/**
 * Move and size a tab.
 *
 * Also how a tab is hidden: the caller puts it below the window, where the OS
 * clips it and the page keeps its size. See the note at the top of this file.
 */
#[tauri::command]
pub async fn browser_place<R: Runtime>(
    window: Window<R>,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = find(&window, &label)?;
    webview
        .set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|error| error.to_string())?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_navigate<R: Runtime>(
    window: Window<R>,
    label: String,
    url: String,
) -> Result<(), String> {
    let target = resolve(&url)?;
    find(&window, &label)?
        .navigate(target)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_close<R: Runtime>(window: Window<R>, label: String) -> Result<(), String> {
    match find(&window, &label) {
        // Closing a tab that is already gone is what a React cleanup does on a
        // reload, and it is not a failure.
        Err(_) => Ok(()),
        Ok(webview) => webview.close().map_err(|error| error.to_string()),
    }
}

/**
 * Evaluate JavaScript in a tab and return the JSON-serialised result.
 *
 * The drive channel, and everything the agent does goes through it. The result
 * is a JSON *string* — `"null"` for an expression that returned nothing — and
 * the caller parses it, because Rust has no business knowing what shape the
 * page's answer is.
 *
 * **It times out, and that is not defensive programming.** A webview torn down
 * while an evaluation is outstanding never calls the callback, and the caller
 * here is a tool call inside a model's turn: without a deadline, closing a tab
 * at the wrong moment wedges the turn with no way back. Found by doing it.
 */
#[tauri::command]
pub async fn browser_eval<R: Runtime>(
    window: Window<R>,
    label: String,
    js: String,
) -> Result<String, String> {
    let webview = find(&window, &label)?;
    let (send, mut receive) = tauri::async_runtime::channel::<Option<String>>(2);
    let deadline = send.clone();
    webview
        .eval_with_callback(js, move |result| {
            // `try_send` rather than a blocking send: this runs on the webview's
            // own thread, and the channel holds exactly the one answer.
            let _ = send.try_send(Some(result));
        })
        .map_err(|error| error.to_string())?;
    // A sleeping thread rather than a timer dependency. It is one thread per
    // evaluation, alive for at most the deadline, and this app has no other
    // reason to pull in a runtime timer.
    std::thread::spawn(move || {
        std::thread::sleep(EVAL_TIMEOUT);
        let _ = deadline.try_send(None);
    });
    match receive.recv().await {
        Some(Some(answer)) => Ok(answer),
        _ => Err("the page did not answer".to_string()),
    }
}

/**
 * Give the keyboard back to the ADE.
 *
 * A tab is a separate HWND, so while the dev is clicking around in a page the
 * command centre shortcut, Escape and the composer keybindings do not fire —
 * they are being delivered to the page. The init script catches Escape and
 * sends `esc` up the navigation channel; this is the other half.
 *
 * It takes the *calling* webview rather than a label, so it can only ever hand
 * focus to the surface that asked for it back.
 */
#[tauri::command]
pub async fn browser_return_focus<R: Runtime>(webview: Webview<R>) -> Result<(), String> {
    webview.set_focus().map_err(|error| error.to_string())
}

/**
 * Hand a URL to the OS browser.
 *
 * The one useful thing a host outside the allow-list can do, and the reason
 * refusing one is not a dead end. `http`/`https` only, and never reachable from
 * the agent: it is offered to the dev when the address row is refused.
 */
#[tauri::command]
pub fn browser_open_external(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|error| format!("{url} is not a URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http and https URLs are handed to the OS browser".to_string());
    }
    let target = parsed.to_string();

    // No shell anywhere in here. `start` would need `cmd`, which parses the URL
    // as a command line; these three take it as one argument and nothing else.
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler").arg(&target);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(&target);
        command
    };
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(&target);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open the OS browser: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(raw: &str) -> bool {
        Url::parse(raw).map(|url| check(&url).is_ok()).unwrap_or(false)
    }

    #[test]
    fn localhost_and_files_are_allowed() {
        assert!(allowed("http://localhost:5173/"));
        assert!(allowed("http://localhost:5190/index.html?a=1"));
        assert!(allowed("https://127.0.0.1:8443/"));
        assert!(allowed("file:///C:/tmp/page.html"));
    }

    #[test]
    fn everything_else_is_refused() {
        assert!(!allowed("https://example.com/"));
        // The one that matters: a host that merely *ends* in the allowed name.
        assert!(!allowed("http://notlocalhost/"));
        assert!(!allowed("http://localhost.example.com/"));
        assert!(!allowed("javascript:alert(1)"));
        assert!(!allowed("data:text/html,<b>hi</b>"));
        assert!(!allowed("ade-ipc:esc"));
    }

    #[test]
    fn a_refusal_names_the_host() {
        let url = Url::parse("https://example.com/x").unwrap();
        let reason = check(&url).unwrap_err();
        assert!(reason.contains("example.com"), "{reason}");
    }
}
