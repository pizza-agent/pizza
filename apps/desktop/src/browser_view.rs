//! Native embedded browser pane with multi-tab support (ZCode-IAB parity).
//!
//! Each tab is a real child webview (WKWebView/WebView2/webkitgtk) with its
//! own label `browser-view-<tabId>`, created over the BrowserPane's viewport
//! rect inside the main window. Pages render natively; the active tab's
//! webview is shown, background tabs stay alive but hidden — like a real
//! browser.
//!
//! Control surface:
//!  - `on_navigation` enforces the scheme allowlist (http/https/about:blank)
//!  - `initialization_script` installs the exec bridge; results come back as
//!    `browser-view-bridge` events (capability: emit-only)
//!  - page load / title events carry the tab id so the panel chrome stays in
//!    sync across tabs

use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{
	webview::{PermissionKind, PermissionResponse, WebviewBuilder},
	AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window,
};

use crate::bridge::log_file;

/// Label prefix shared by every tab webview; the capability grants
/// `browser-view*` (glob) emit-only access.
pub const BROWSER_VIEW_LABEL: &str = "browser-view";

/// Chrome-shaped UA presented by every tab (ZCode's Electron IAB keeps
/// Chromium's default UA; a bare WKWebView UA reads as an unknown client to
/// risk engines like Baidu's, which answers with CAPTCHAs).
const BROWSER_VIEW_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Keep memory bounded the same way the mirror engine's tab registry does.
const MAX_TABS: usize = 8;

/// The bridge injected into every page the tab webviews load. Results come
/// back over a dual transport:
///  1. primary: the Tauri event plugin (`plugin:event|emit`, emit-only
///     capability, granted to remote origins via `remote.urls`)
///  2. fallback: a synthetic `pizza-bridge:<encoded-json>` navigation that
///     the Rust on_navigation handler intercepts, decodes, and re-emits —
///     zero-capability, works even when the event invoke is rejected
///     asynchronously (which a synchronous try/catch can never see).
/// It also rewrites `target=_blank` links and `window.open` to in-place
/// navigation — a child webview cannot open new windows, so without this
/// half the web (Baidu result links included) appears "dead" on click.
const BRIDGE_INIT_SCRIPT: &str = r#"
(function () {
  if (window.__pizzaBrowserBridgeInstalled) return;
  window.__pizzaBrowserBridgeInstalled = true;
  var sendViaNavigation = function (text) {
    if (text.length > 60000) text = text.slice(0, 60000);
    try { window.location.href = 'pizza-bridge:' + text; } catch (e) { /* lost */ }
  };
  var send = function (payload) {
    var encoded = encodeURIComponent(JSON.stringify(payload));
    var fallback = function () { sendViaNavigation(encoded); };
    try {
      var p = window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
        event: 'browser-view-bridge',
        payload: payload
      });
      if (p && typeof p.then === 'function') p.then(undefined, fallback);
    } catch (e) { fallback(); }
  };
  window.__pizzaBrowserBridgeSend = send;
  window.__pizzaExec = function (id, src) {
    Promise.resolve()
      .then(function () { return (0, eval)(src); })
      .then(
        function (v) { send({ id: id, ok: true, result: v === undefined ? null : v }); },
        function (e) { send({ id: id, ok: false, error: String((e && e.message) || e) }); }
      );
  };
  // target=_blank → navigate in place (the pane has no window.open). Skipped
  // while the element picker is active — picking a link must capture it, not
  // follow it (the picker registers window.__pizzaWebElementPicker while
  // running and this handler is registered earlier, so the picker's own
  // stopImmediatePropagation can never preempt it).
  document.addEventListener('click', function (e) {
    if (window.__pizzaWebElementPicker) return;
    var el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (el && el.target && el.target !== '_self') {
      e.preventDefault();
      if (el.href) window.location.href = el.href;
    }
  }, true);
  window.open = function (url) { if (url) window.location.href = url; return null; };
  send({ event: 'ready', url: location.href, title: document.title });
})();
"#;

#[derive(Default)]
pub struct BrowserViewState {
	/// All live tab webviews: (tab_id, webview).
	tabs: Mutex<Vec<(String, Webview)>>,
	/// Last known rect (CSS px) — applied to newly opened tabs immediately.
	rect: Mutex<(f64, f64, f64, f64)>,
	/// Whether the pane is visible (hidden pane keeps tabs alive).
	visible: Mutex<bool>,
	/// Currently active tab id (the one webview shown over the pane).
	active_tab: Mutex<Option<String>>,
	/// Origins the user explicitly granted a permission to ("origin|kind").
	/// The WKWebView permission callback is synchronous, so interactive
	/// prompts are impossible — instead: deny + notify, remember the grant,
	/// and allow the site's next request.
	granted_permissions: Mutex<HashSet<String>>,
}

fn permission_key(origin: &str, kind: &str) -> String {
	format!("{origin}|{kind}")
}

fn permission_kind_name(kind: PermissionKind) -> &'static str {
	match kind {
		PermissionKind::Microphone => "microphone",
		PermissionKind::Camera => "camera",
		PermissionKind::Geolocation => "geolocation",
		PermissionKind::Notifications => "notifications",
		PermissionKind::ClipboardRead => "clipboard-read",
		PermissionKind::DisplayCapture => "display-capture",
		PermissionKind::Midi => "midi",
		PermissionKind::Sensors => "sensors",
		PermissionKind::MediaKeySystemAccess => "media-key-system",
		PermissionKind::LocalFonts => "local-fonts",
		PermissionKind::WindowManagement => "window-management",
		PermissionKind::PointerLock => "pointer-lock",
		_ => "other",
	}
}

fn sanitize_tab_id(tab_id: &str) -> Result<String, String> {
	let clean: String = tab_id
		.chars()
		.filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
		.collect();
	if clean.is_empty() {
		Err("invalid tab id".to_string())
	} else {
		Ok(clean)
	}
}

fn tab_label(tab_id: &str) -> String {
	format!("{BROWSER_VIEW_LABEL}-{tab_id}")
}

/// Extract the tab id back out of a webview label ("browser-view-t3" → "t3").
fn label_tab_id(label: &str) -> String {
	label
		.strip_prefix(&format!("{BROWSER_VIEW_LABEL}-"))
		.unwrap_or(label)
		.to_string()
}

fn create_tab_webview(window: &Window, tab_id: &str, start: &tauri::Url) -> tauri::Result<Webview> {
	let app = window.app_handle();
	let navigation_app = app.clone();
	// Persistent profile shared by all tabs (ZCode parity: its Electron IAB
	// uses the `persist:zcode-embedded-browser` partition). Cookies/history
	// survive restarts, so risk engines see a long-lived browser.
	let data_dir = match app.path().home_dir() {
		Ok(home) => home.join(".pizza").join("browser-view"),
		Err(_) => std::env::temp_dir().join("pizza-browser-view"),
	};
	let label = tab_label(tab_id);
	let builder = WebviewBuilder::new(label.as_str(), WebviewUrl::External(start.clone()))
		.initialization_script(BRIDGE_INIT_SCRIPT)
		.user_agent(BROWSER_VIEW_USER_AGENT)
		.data_directory(data_dir)
		.focused(false)
		// macOS: without this the first click into an unfocused webview only
		// activates it — links feel dead until the second click.
		.accept_first_mouse(true)
		.on_navigation(move |url| {
			let scheme = url.scheme();
			// Bridge fallback transport: pages that cannot use the event
			// plugin encode their result into a synthetic navigation. Decode
			// and re-emit it exactly like a normal bridge event.
			if scheme == "pizza-bridge" {
				let encoded = url.path().to_string();
				let decoded = percent_encoding::percent_decode_str(&encoded)
					.decode_utf8_lossy()
					.to_string();
				// Re-emit as a JSON value so the frontend listener sees the
				// same object shape the primary event transport produces.
				let value: serde_json::Value =
					serde_json::from_str(&decoded).unwrap_or(serde_json::Value::String(decoded));
				let _ = navigation_app.emit("browser-view-bridge", value);
				return false;
			}
			scheme == "http" || scheme == "https" || url.as_str() == "about:blank"
		})
		.on_new_window(|_url, _features| {
			// The bridge already rewrites target=_blank to in-place
			// navigation; anything else (window.open fallback paths) must not
			// escape the pane.
			tauri::webview::NewWindowResponse::Deny
		})
		.on_permission_request(|webview, kind| {
			let app = webview.app_handle().clone();
			let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
			let origin = url.splitn(4, '/').take(3).collect::<Vec<_>>().join("/");
			let kind_name = permission_kind_name(kind);
			let state = app.state::<BrowserViewState>();
			if state
				.granted_permissions
				.lock()
				.unwrap()
				.contains(&permission_key(&origin, kind_name))
			{
				return PermissionResponse::Allow;
			}
			// Synchronous callback: deny now and surface the request to the
			// pane, which offers "allow" (remembered for the session) — the
			// site's next request goes through.
			let _ = webview.emit(
				"browser-view-permission",
				serde_json::json!({ "origin": origin, "kind": kind_name }),
			);
			log_file(&format!(
				"browser_view: permission denied {origin} {kind_name}"
			));
			PermissionResponse::Deny
		})
		.on_page_load(|webview, payload| {
			let tab_id = label_tab_id(webview.label());
			let event = match payload.event() {
				tauri::webview::PageLoadEvent::Started => "started",
				tauri::webview::PageLoadEvent::Finished => "finished",
			};
			let _ = webview.emit(
				"browser-view-page",
				serde_json::json!({ "tabId": tab_id, "event": event, "url": payload.url() }),
			);
		})
		.on_document_title_changed(|webview, title| {
			let tab_id = label_tab_id(webview.label());
			let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
			let _ = webview.emit(
				"browser-view-title",
				serde_json::json!({ "tabId": tab_id, "title": title, "url": url }),
			);
		});

	let (x, y, w, h) = *app.state::<BrowserViewState>().rect.lock().unwrap();
	let webview = window.add_child(
		builder,
		LogicalPosition::new(x, y),
		LogicalSize::new(w.max(1.0), h.max(1.0)),
	)?;
	log_file(&format!("browser_view: tab {tab_id} created"));
	Ok(webview)
}

fn with_tab<F: FnOnce(&Webview) -> Result<(), String>>(
	state: &BrowserViewState,
	tab_id: &str,
	f: F,
) -> Result<(), String> {
	let tabs = state.tabs.lock().unwrap();
	let tab = tabs
		.iter()
		.find(|(id, _)| id == tab_id)
		.map(|(_, w)| w)
		.ok_or_else(|| format!("unknown tab: {tab_id}"))?;
	f(tab)
}

/// Normalize user input the way a browser address bar does: bare hosts get
/// https:// prepended so `Url::parse` succeeds ("baidu.com" →
/// "https://baidu.com").
fn normalize_user_url(url: &str) -> Result<tauri::Url, String> {
	let trimmed = url.trim();
	let normalized = if trimmed.contains("://") || trimmed == "about:blank" {
		trimmed.to_string()
	} else {
		format!("https://{trimmed}")
	};
	let parsed: tauri::Url = normalized
		.parse()
		.map_err(|e| format!("invalid url: {e}"))?;
	let scheme = parsed.scheme();
	if scheme != "http" && scheme != "https" && parsed.as_str() != "about:blank" {
		return Err(format!("scheme not allowed: {scheme}"));
	}
	Ok(parsed)
}

/// Open a new tab, hide the others, and activate it.
#[tauri::command]
pub fn browser_view_open_tab(
	window: Window,
	app: AppHandle,
	tab_id: String,
	url: String,
) -> Result<(), String> {
	let tab_id = sanitize_tab_id(&tab_id)?;
	let parsed = normalize_user_url(&url)?;
	let state = app.state::<BrowserViewState>();
	{
		let mut tabs = state.tabs.lock().unwrap();
		if tabs.iter().any(|(id, _)| *id == tab_id) {
			return Err(format!("tab already exists: {tab_id}"));
		}
		if tabs.len() >= MAX_TABS {
			return Err(format!("tab limit reached ({MAX_TABS})"));
		}
	}
	let webview = create_tab_webview(&window, &tab_id, &parsed).map_err(|e| e.to_string())?;
	{
		let state = app.state::<BrowserViewState>();
		let mut tabs = state.tabs.lock().unwrap();
		// Hide the previously active tab(s): the newcomer takes the pane.
		for (_, w) in tabs.iter() {
			let _ = w.hide();
		}
		tabs.push((tab_id.clone(), webview));
		*state.active_tab.lock().unwrap() = Some(tab_id.clone());
	}
	log_file(&format!("browser_view: navigate {tab_id} {parsed}"));
	Ok(())
}

/// Navigate an existing tab.
#[tauri::command]
pub fn browser_view_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
	let tab_id = sanitize_tab_id(&tab_id)?;
	let parsed = normalize_user_url(&url)?;
	let state = app.state::<BrowserViewState>();
	let result = with_tab(&state, &tab_id, |w| {
		w.navigate(parsed.clone()).map_err(|e| e.to_string())
	});
	log_file(&format!("browser_view: navigate {tab_id} {parsed}"));
	result
}

/// Activate one tab (show it, hide the others).
#[tauri::command]
pub fn browser_view_activate_tab(app: AppHandle, tab_id: String) -> Result<(), String> {
	let tab_id = sanitize_tab_id(&tab_id)?;
	let state = app.state::<BrowserViewState>();
	*state.active_tab.lock().unwrap() = Some(tab_id.clone());
	let tabs = state.tabs.lock().unwrap();
	let visible = *state.visible.lock().unwrap();
	let mut found = false;
	for (id, w) in tabs.iter() {
		let show = *id == tab_id && visible;
		if show {
			found = true;
			let _ = w.show();
			let _ = w.set_focus();
		} else {
			let _ = w.hide();
		}
	}
	if !found {
		return Err(format!("unknown tab: {tab_id}"));
	}
	log_file(&format!("browser_view: activate {tab_id}"));
	Ok(())
}

/// Close one tab (destroys its webview). Returns the remaining tab ids so
/// the frontend can pick the next active one.
#[tauri::command]
pub fn browser_view_close_tab(app: AppHandle, tab_id: String) -> Result<Vec<String>, String> {
	let tab_id = sanitize_tab_id(&tab_id)?;
	let state = app.state::<BrowserViewState>();
	let removed = {
		let mut tabs = state.tabs.lock().unwrap();
		let index = tabs.iter().position(|(id, _)| *id == tab_id);
		match index {
			Some(i) => tabs.remove(i).1,
			None => return Err(format!("unknown tab: {tab_id}")),
		}
	};
	let _ = removed.close();
	let state = app.state::<BrowserViewState>();
	// If the active tab was closed, clear the pointer; the frontend follows
	// up with browser_view_activate_tab for the next survivor.
	{
		let mut active = state.active_tab.lock().unwrap();
		if active.as_deref() == Some(tab_id.as_str()) {
			*active = None;
		}
	}
	let remaining: Vec<String> = state
		.tabs
		.lock()
		.unwrap()
		.iter()
		.map(|(id, _)| id.clone())
		.collect();
	log_file(&format!(
		"browser_view: closed {tab_id}, remaining {:?}",
		remaining
	));
	Ok(remaining)
}

/// Apply the pane rect to every tab (switching tabs is then instant).
#[tauri::command]
pub fn browser_view_set_rect(
	app: AppHandle,
	x: f64,
	y: f64,
	width: f64,
	height: f64,
) -> Result<(), String> {
	let state = app.state::<BrowserViewState>();
	{
		let mut rect = state.rect.lock().unwrap();
		*rect = (x, y, width.max(1.0), height.max(1.0));
	}
	let tabs = state.tabs.lock().unwrap();
	let visible = *state.visible.lock().unwrap();
	let active = state.active_tab.lock().unwrap().clone();
	// A transient zero-size rect (mid-resize animation, fullscreen
	// transition) only hides the tabs momentarily — it must NOT flip the
	// pane's visibility state, or the content stays gone after the resize
	// settles.
	if width <= 0.0 || height <= 0.0 {
		for (_, w) in tabs.iter() {
			let _ = w.hide();
		}
		return Ok(());
	}
	let mut any_failed = None;
	for (id, w) in tabs.iter() {
		let result = w
			.set_position(LogicalPosition::new(x, y))
			.and_then(|_| w.set_size(LogicalSize::new(width, height)));
		if let Err(e) = result {
			any_failed = Some(e.to_string());
			continue;
		}
		let show = visible && active.as_deref() == Some(id.as_str());
		if show {
			let _ = w.show();
		} else {
			let _ = w.hide();
		}
	}
	log_file(&format!(
		"browser_view: rect x={x:.0} y={y:.0} w={width:.0} h={height:.0} tabs={}",
		tabs.len()
	));
	match any_failed {
		Some(e) => {
			log_file(&format!("browser_view: rect FAILED: {e}"));
			Err(e)
		}
		None => Ok(()),
	}
}

/// Show/hide the whole pane (all tabs). Hidden tabs stay alive. Showing the
/// pane re-applies the stored rect and reveals the active tab (the frontend
/// may not follow up with set_rect).
#[tauri::command]
pub fn browser_view_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
	let state = app.state::<BrowserViewState>();
	*state.visible.lock().unwrap() = visible;
	if visible {
		let (x, y, w, h) = *state.rect.lock().unwrap();
		let active = state.active_tab.lock().unwrap().clone();
		let tabs = state.tabs.lock().unwrap();
		for (id, webview) in tabs.iter() {
			let show = active.as_deref() == Some(id.as_str());
			if show {
				let _ = webview.set_position(LogicalPosition::new(x, y));
				let _ = webview.set_size(LogicalSize::new(w, h));
				let _ = webview.show();
			} else {
				let _ = webview.hide();
			}
		}
	} else {
		let tabs = state.tabs.lock().unwrap();
		for (_, w) in tabs.iter() {
			let _ = w.hide();
		}
	}
	log_file(&format!("browser_view: set_visible {visible}"));
	Ok(())
}

#[tauri::command]
pub fn browser_view_focus(app: AppHandle, tab_id: String) -> Result<(), String> {
	let tab_id = sanitize_tab_id(&tab_id)?;
	let state = app.state::<BrowserViewState>();
	with_tab(&state, &tab_id, |w| {
		w.set_focus().map_err(|e| e.to_string())
	})
}

/// Evaluate JavaScript in a tab. The result comes back asynchronously as a
/// `browser-view-bridge` event; correlate via the caller-supplied `id`.
#[tauri::command]
pub fn browser_view_exec(
	app: AppHandle,
	tab_id: String,
	id: String,
	code: String,
) -> Result<(), String> {
	let tab_id = sanitize_tab_id(&tab_id)?;
	let state = app.state::<BrowserViewState>();
	with_tab(&state, &tab_id, |w| {
		let payload = serde_json::to_string(&code).map_err(|e| e.to_string())?;
		let js = format!("window.__pizzaExec && window.__pizzaExec({id:?}, {payload})");
		w.eval(js.as_str()).map_err(|e| e.to_string())
	})
}

/// Navigate back in a tab's session history (via the in-page history API —
/// Tauri does not expose WKWebView goBack for child webviews).
#[tauri::command]
pub fn browser_view_go_back(app: AppHandle, tab_id: String) -> Result<(), String> {
	let tab_id = sanitize_tab_id(&tab_id)?;
	let state = app.state::<BrowserViewState>();
	log_file(&format!("browser_view: back {tab_id}"));
	with_tab(&state, &tab_id, |w| {
		w.eval("window.history && window.history.back();")
			.map_err(|e| e.to_string())
	})
}

/// Navigate forward in a tab's session history.
#[tauri::command]
pub fn browser_view_go_forward(app: AppHandle, tab_id: String) -> Result<(), String> {
	let tab_id = sanitize_tab_id(&tab_id)?;
	let state = app.state::<BrowserViewState>();
	log_file(&format!("browser_view: forward {tab_id}"));
	with_tab(&state, &tab_id, |w| {
		w.eval("window.history && window.history.forward();")
			.map_err(|e| e.to_string())
	})
}

/// Reload the active page of a tab (native WKWebView reload).
#[tauri::command]
pub fn browser_view_reload(app: AppHandle, tab_id: String) -> Result<(), String> {
	let tab_id = sanitize_tab_id(&tab_id)?;
	let state = app.state::<BrowserViewState>();
	log_file(&format!("browser_view: reload {tab_id}"));
	with_tab(&state, &tab_id, |w| w.reload().map_err(|e| e.to_string()))
}

/// Remember (or forget) a granted site permission. Grants live for the app
/// session; sites must re-request after the pane told the user it was
/// blocked (the WKWebView callback is synchronous, so the grant applies to
/// the site's NEXT request).
#[tauri::command]
pub fn browser_view_allow_permission(
	app: AppHandle,
	origin: String,
	kind: String,
	allowed: bool,
) -> Result<(), String> {
	let state = app.state::<BrowserViewState>();
	let key = permission_key(&origin, &kind);
	let mut grants = state.granted_permissions.lock().unwrap();
	if allowed {
		grants.insert(key.clone());
	} else {
		grants.remove(&key);
	}
	drop(grants);
	log_file(&format!(
		"browser_view: permission {kind} for {origin} {}",
		if allowed { "granted" } else { "revoked" }
	));
	Ok(())
}

/// Return keyboard focus to the MAIN app webview. After picking an element
/// (or any interaction inside the native pane) macOS keeps the first
/// responder on the child WKWebView — without this, typing goes to the page
/// instead of the chat composer.
#[tauri::command]
pub fn browser_view_focus_main(window: Window) -> Result<(), String> {
	if let Some(main) = window.webviews().into_iter().find(|w| w.label() == "main") {
		let _ = main.set_focus();
		log_file("browser_view: focus returned to main webview");
	}
	Ok(())
}

/// List all permissions granted this session (for the pane's manage panel).
#[tauri::command]
pub fn browser_view_list_permissions(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
	let state = app.state::<BrowserViewState>();
	let grants = state.granted_permissions.lock().unwrap();
	Ok(grants
		.iter()
		.filter_map(|key| {
			let (origin, kind) = key.split_once('|')?;
			Some(serde_json::json!({ "origin": origin, "kind": kind }))
		})
		.collect())
}

/// Wake the active tab's renderer after a live resize. WKWebView content
/// can freeze mid-way through continuous window resizes (WebKit bug 323132);
/// the reliable workaround is nudging the frame by 1px and back plus a
/// hide/show cycle once the resize settles.
#[tauri::command]
pub fn browser_view_refresh(app: AppHandle) -> Result<(), String> {
	let state = app.state::<BrowserViewState>();
	let (x, y, w, h) = *state.rect.lock().unwrap();
	let active = state.active_tab.lock().unwrap().clone();
	let tabs = state.tabs.lock().unwrap();
	for (id, webview) in tabs.iter() {
		if active.as_deref() != Some(id.as_str()) {
			continue;
		}
		let _ = webview.set_position(LogicalPosition::new(x, y));
		let _ = webview.set_size(LogicalSize::new(w + 1.0, h));
		let _ = webview.set_size(LogicalSize::new(w, h));
		let _ = webview.hide();
		let _ = webview.show();
	}
	log_file("browser_view: refresh (renderer wake after resize)");
	Ok(())
}

/// Open the native DevTools window for a tab (ZCode parity — its Electron
/// IAB exposes webContents.openDevTools).
#[tauri::command]
pub fn browser_view_open_devtools(app: AppHandle, tab_id: String) -> Result<(), String> {
	let tab_id = sanitize_tab_id(&tab_id)?;
	let state = app.state::<BrowserViewState>();
	let result = with_tab(&state, &tab_id, |w| {
		w.open_devtools();
		Ok(())
	});
	log_file(&format!("browser_view: devtools {tab_id}"));
	result
}
