use crate::gateway_channel;
use crate::remote;
use crate::remote_deploy;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Read an API key for a provider from ~/.pizza/agent/auth.json.
fn read_api_key(provider: &str) -> Option<String> {
	let auth_path = home_dir()?.join(".pizza").join("agent").join("auth.json");
	let raw = std::fs::read_to_string(&auth_path).ok()?;
	let parsed: Value = serde_json::from_str(&raw).ok()?;
	let key = parsed.get(provider)?.get("key")?.as_str()?.to_string();
	if key.is_empty() {
		None
	} else {
		Some(key)
	}
}

/// Bridge log lives in the OS temp dir — /tmp does not exist on Windows.
fn bridge_log_path() -> &'static PathBuf {
	static CACHED: OnceLock<PathBuf> = OnceLock::new();
	CACHED.get_or_init(|| std::env::temp_dir().join("pizza-gui-bridge.log"))
}

/// Rotate the bridge log once it exceeds ~10MB so it can't grow unbounded
/// (get_state polling + per-rpc_response logging writes a lot).
const BRIDGE_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;

pub(crate) fn log_file(msg: &str) {
	use std::io::Write;
	let log_path = bridge_log_path();
	// Best-effort rotation: if the log is too big, move it aside and start fresh.
	// Errors here are non-fatal — we still want the line written.
	if let Ok(meta) = std::fs::metadata(log_path) {
		if meta.len() > BRIDGE_LOG_MAX_BYTES {
			let _ = std::fs::rename(log_path, log_path.with_extension("log.old"));
		}
	}
	if let Ok(mut f) = std::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(log_path)
	{
		let _ = writeln!(f, "{}", msg);
	}
}

fn find_node() -> Option<String> {
	// Check PIZZA_NODE env var first.
	if let Ok(node) = std::env::var("PIZZA_NODE") {
		if std::path::Path::new(&node).exists() {
			return Some(node);
		}
	}
	// Try nvm first — nvm versions are usually newer and have node:sqlite.
	if let Some(home) = home_dir() {
		let nvm_node = home.join(".nvm").join("versions").join("node");
		if let Ok(entries) = std::fs::read_dir(&nvm_node) {
			let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).collect();
			versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
			for v in versions {
				let node_path = v.path().join("bin/node");
				if node_path.exists() {
					return Some(node_path.to_string_lossy().to_string());
				}
			}
		}
	}
	// Check common locations (homebrew, system).
	let candidates = [
		"/opt/homebrew/bin/node",
		"/usr/local/bin/node",
		"/usr/bin/node",
	];
	for c in &candidates {
		if std::path::Path::new(c).exists() {
			return Some(c.to_string());
		}
	}
	// Fallback to "node" and hope PATH works.
	Some("node".to_string())
}
/// Run the user's login shell once and capture the PATH it would set in an
/// interactive terminal, so the GUI-launched sidecar (which inherits launchd's
/// minimal PATH and never sources ~/.zprofile / ~/.bash_profile) still finds
/// tools the user installed via homebrew/cargo/nvm/etc.
///
/// Runs `<shell> -lic 'printf %s "$PATH"'` with stdin wired to /dev/null and a
/// hard timeout, so a misbehaving rc file can't hang the app. The result is
/// cached per process via OnceLock.
fn capture_login_shell_path() -> Option<String> {
	// Prefer the user's configured login shell, then common fallbacks.
	let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty());
	let candidates: Vec<String> = match shell {
		Some(s) => vec![s, "/bin/zsh".to_string(), "/bin/bash".to_string()],
		None => vec!["/bin/zsh".to_string(), "/bin/bash".to_string()],
	};

	for shell in candidates {
		if !PathBuf::from(&shell).exists() {
			continue;
		}
		match run_shell_capture_path(&shell) {
			Some(path) if !path.trim().is_empty() => return Some(path),
			_ => continue,
		}
	}
	None
}

/// Spawn `<shell> -lic 'printf %s "$PATH"'` with a timeout and return its
/// trimmed stdout. Returns None on timeout, non-zero exit, or empty output.
fn run_shell_capture_path(shell: &str) -> Option<String> {
	const TIMEOUT: Duration = Duration::from_secs(3);

	let (tx, rx) = std::sync::mpsc::channel();
	let shell = shell.to_string();
	thread::spawn(move || {
		let result = (|| {
			let output = Command::new(&shell)
				.args(["-lic", "printf %s \"$PATH\""])
				.stdin(Stdio::null())
				.stdout(Stdio::piped())
				.stderr(Stdio::piped())
				.output()
				.ok()?;
			if !output.status.success() {
				return None;
			}
			let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
			if path.is_empty() {
				None
			} else {
				Some(path)
			}
		})();
		let _ = tx.send(result);
	});

	match rx.recv_timeout(TIMEOUT) {
		Ok(value) => value,
		Err(_) => None, // timed out — give up on this shell
	}
}

/// Resolve the PATH to pass to sidecars: the login-shell PATH if we could
/// capture one, otherwise the process's inherited PATH. Cached per process.
fn resolve_shell_path() -> String {
	static CACHED: OnceLock<Option<String>> = OnceLock::new();
	let cached = CACHED.get_or_init(capture_login_shell_path);
	match cached {
		Some(path) => path.clone(),
		None => std::env::var("PATH").unwrap_or_default(),
	}
}

fn resolve_pizza_command(app: &AppHandle) -> (String, Vec<String>) {
	// 1. PIZZA_BIN env var — explicit override (any executable, including a
	//    manually-built `dist/pizza` Bun binary).
	if let Ok(bin) = std::env::var("PIZZA_BIN") {
		let parts: Vec<&str> = bin.split_whitespace().collect();
		if parts.len() >= 2 {
			return (
				parts[0].to_string(),
				parts[1..]
					.iter()
					.map(|s| s.to_string())
					.chain(["--mode".to_string(), "rpc".to_string()])
					.collect(),
			);
		}
		return (
			parts[0].to_string(),
			vec!["--mode".to_string(), "rpc".to_string()],
		);
	}

	// 2. Packaged binary bundled via tauri.conf.json `bundle.resources`.
	//    The resource_dir is the runtime location of bundled assets
	//    (e.g. inside the .app bundle on macOS). When present, this makes
	//    the desktop app self-contained — no Node.js required.
	//    On Windows the binary has a .exe extension.
	//    Skipped in debug builds: in dev the resource_dir points at
	//    target/debug/ where a stale dist/pizza may exist from a prior
	//    `build:binary`, which can hang the sidecar.
	if !cfg!(debug_assertions) {
		if let Ok(resource_dir) = app.path().resource_dir() {
			let pizza_bin = resource_dir.join(if cfg!(windows) { "pizza.exe" } else { "pizza" });
			if pizza_bin.exists() {
				log_file(&format!(
					"resolve_pizza_command: using bundled binary at {}",
					pizza_bin.display()
				));
				return (
					pizza_bin.to_string_lossy().to_string(),
					vec!["--mode".to_string(), "rpc".to_string()],
				);
			}
		}
	}

	// 3. Dev fallback: run `node dist/src/cli.js` from the source tree.
	let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("..")
		.join("..");
	let cli_js = project_root.join("dist").join("src").join("cli.js");
	let loader = project_root.join("scripts").join("module-resolver.mjs");
	let node = find_node().unwrap_or_else(|| "node".to_string());
	log_file(&format!(
		"resolve_pizza_command: dev fallback, node={}, cli_js={}, loader={}",
		node,
		cli_js.display(),
		loader.display()
	));
	(
		node,
		vec![
			"--loader".to_string(),
			loader.to_string_lossy().to_string(),
			cli_js.to_string_lossy().to_string(),
			"--mode".to_string(),
			"rpc".to_string(),
		],
	)
}

/// The gateway daemon runs the same executable as the sidecar, minus the
/// sidecar's `--mode rpc` (ensure_gateway appends `--mode gateway`). Leaving
/// it in produced `pizza --mode rpc --mode gateway`, which only worked
/// because the last `--mode` happens to win.
fn gateway_command((program, mut args): (String, Vec<String>)) -> (String, Vec<String>) {
	if args.ends_with(&["--mode".to_string(), "rpc".to_string()]) {
		args.truncate(args.len() - 2);
	}
	(program, args)
}

/// Sidecar entry: the process + which windows are using it.
struct SidecarEntry {
	child: Child,
	stdin: ChildStdin,
}

/// One SSH local-forward used to expose a loopback-only remote service (PTY or
/// browser frame server) to the desktop webview.
struct RemoteTunnel {
	local_port: u16,
	child: Child,
}

/// Per-remote-workspace transport state. The SSH ControlMaster is owned by the
/// long-lived remote Pizza process; this map only tracks forwarding children.
struct RemoteRuntime {
	control_socket: PathBuf,
	tunnels: HashMap<u16, RemoteTunnel>,
	gateway_tunnel: Option<Child>,
	gateway_local_socket: Option<PathBuf>,
}

#[derive(Default)]
struct RemoteProvisioningLane {
	/// Whether one sync worker currently owns the lane.
	running: bool,
	/// Every trigger advances generation. The worker tails the latest value.
	generation: u64,
	/// Response waiters used to verify the remote registry reload barrier.
	waiters: HashMap<String, std::sync::mpsc::Sender<Value>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttachmentInfo {
	kind: &'static str,
	absolute_path: String,
	relative_path: String,
	mime_type: String,
	name: String,
	size: u64,
}

pub struct BridgeState {
	/// Gateway channels keyed by cwd (gateway-mode only; PIZZA_DESKTOP_GATEWAY).
	channels: Mutex<HashMap<String, gateway_channel::GatewayChannel>>,
	/// Sidecars keyed by cwd.
	sidecars: Mutex<HashMap<String, SidecarEntry>>,
	/// Active cwd per window label.
	active: Mutex<HashMap<String, String>>,
	/// cwds that are currently being intentionally restarted by
	/// `restart_sidecar`. The auto-restart path in the GUI checks this
	/// before respawning a sidecar whose exit it observed, so the
	/// user-initiated restart doesn't get clobbered by a race.
	restarting: Mutex<HashSet<String>>,
	/// Active OAuth login child (`pizza auth login --mode jsonl`), if any.
	oauth_login: Mutex<Option<OAuthLoginChild>>,
	/// Cached `pizza auth list --json` result. The option list only changes
	/// when the pizza binary is upgraded, so it is warmed at app startup and
	/// kept for the session — spawning the CLI for every Settings open takes
	/// >1s and made the "Sign in with an account" section visibly delayed.
	auth_options_cache: Mutex<Option<Vec<AuthLoginOption>>>,
	/// Last `pet_state` frame — replayed into the floating pet window when it
	/// (re)opens so it doesn't sit on the placeholder until the next change.
	pet_state_frame: Mutex<Option<Value>>,
	/// SSH remote workspace definitions keyed by the synthetic `remote://` cwd.
	remote_workspaces: Mutex<HashMap<String, remote::RemoteWorkspaceConfig>>,
	/// Runtime SSH forwarding state keyed by the same remote workspace cwd.
	remote_runtimes: Mutex<HashMap<String, RemoteRuntime>>,
	/// Per-environment single-flight lane for Local -> Remote provider sync.
	remote_provisioning: Mutex<RemoteProvisioningLane>,
	/// Serializes remote workspace initialization per desktop window. Without
	/// this, rapid workspace clicks can attach out of order and leave the
	/// bridge's active pointer on the older selection.
	remote_init_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
	/// Serializes server install/start per SSH environment (keyed by its
	/// control socket path), so two windows opening projects on the same host
	/// never upload and install concurrently.
	remote_install_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

/// A running `pizza auth login --mode jsonl` child plus its stdin writer.
struct OAuthLoginChild {
	child: std::process::Child,
	stdin: std::process::ChildStdin,
}

impl Default for BridgeState {
	fn default() -> Self {
		Self {
			channels: Mutex::new(HashMap::new()),
			sidecars: Mutex::new(HashMap::new()),
			active: Mutex::new(HashMap::new()),
			restarting: Mutex::new(HashSet::new()),
			oauth_login: Mutex::new(None),
			auth_options_cache: Mutex::new(None),
			pet_state_frame: Mutex::new(None),
			remote_workspaces: Mutex::new(remote::load_remote_workspaces()),
			remote_runtimes: Mutex::new(HashMap::new()),
			remote_provisioning: Mutex::new(RemoteProvisioningLane::default()),
			remote_init_locks: Mutex::new(HashMap::new()),
			remote_install_locks: Mutex::new(HashMap::new()),
		}
	}
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainAgentStatus {
	running: bool,
	pid: Option<u32>,
	command: Option<String>,
	lock_path: String,
}

/// Kill and remove the sidecar for a specific cwd.
pub fn kill_sidecar_for_cwd(state: &BridgeState, cwd: &str) {
	log_file(&format!("kill_sidecar_for_cwd: cwd={}", cwd));
	let mut sidecars = state.sidecars.lock().unwrap();
	if let Some(mut sidecar) = sidecars.remove(cwd) {
		let _ = sidecar.child.kill();
		let _ = sidecar.child.wait();
		log_file(&format!("kill_sidecar_for_cwd: killed sidecar for {}", cwd));
	}
	drop(sidecars);
	if remote::is_remote_workspace_key(cwd) {
		stop_remote_runtime(state, cwd);
	}
}

fn remote_workspace_config(
	state: &BridgeState,
	cwd: &str,
) -> Option<remote::RemoteWorkspaceConfig> {
	lock_ok(&state.remote_workspaces).get(cwd).cloned()
}

fn gateway_workspace_for_cwd(state: &BridgeState, cwd: &str) -> String {
	remote_workspace_config(state, cwd)
		.map(|config| config.remote_path)
		.unwrap_or_else(|| cwd.to_string())
}

fn same_remote_workspace(
	left: &remote::RemoteWorkspaceConfig,
	right: &remote::RemoteWorkspaceConfig,
) -> bool {
	left.ssh_target == right.ssh_target
		&& left.port.unwrap_or(22) == right.port.unwrap_or(22)
		&& left.remote_path == right.remote_path
}

fn online_remote_workspaces(state: &BridgeState) -> Vec<(String, remote::RemoteWorkspaceConfig)> {
	let mut running: HashSet<String> = lock_ok(&state.sidecars).keys().cloned().collect();
	running.extend(lock_ok(&state.channels).keys().cloned());
	lock_ok(&state.remote_workspaces)
		.iter()
		.filter(|(cwd, _)| running.contains(*cwd))
		.map(|(cwd, config)| (cwd.clone(), config.clone()))
		.collect()
}

fn complete_remote_reload_waiter(state: &BridgeState, frame: &Value) {
	if frame.get("type").and_then(Value::as_str) != Some("response") {
		return;
	}
	let Some(id) = frame.get("id").and_then(Value::as_str) else {
		return;
	};
	let waiter = lock_ok(&state.remote_provisioning).waiters.remove(id);
	if let Some(sender) = waiter {
		let _ = sender.send(frame.clone());
	}
}

fn reload_remote_provider_registry(state: &BridgeState, cwd: &str) -> Result<(), String> {
	if let Some(channel) = lock_ok(&state.channels).get(cwd).cloned() {
		let gateway_workspace = gateway_workspace_for_cwd(state, cwd);
		let response = channel.rpc(
			&gateway_workspace,
			serde_json::json!({
				"id": uuid::Uuid::new_v4().to_string(),
				"type": "reload_providers"
			}),
		)?;
		if response.get("success").and_then(Value::as_bool) != Some(true) {
			return Err(response
				.get("error")
				.and_then(Value::as_str)
				.unwrap_or("Remote provider registry reload failed")
				.to_string());
		}
		return Ok(());
	}

	let id = uuid::Uuid::new_v4().to_string();
	let (sender, receiver) = std::sync::mpsc::channel();
	lock_ok(&state.remote_provisioning)
		.waiters
		.insert(id.clone(), sender);
	let write_result = {
		let mut sidecars = lock_ok(&state.sidecars);
		let sidecar = sidecars
			.get_mut(cwd)
			.ok_or_else(|| "Remote sidecar is not running".to_string())?;
		write_rpc_line(
			sidecar,
			serde_json::json!({
				"id": id,
				"type": "reload_providers"
			}),
		)
	};
	if let Err(error) = write_result {
		lock_ok(&state.remote_provisioning).waiters.remove(&id);
		return Err(error);
	}
	let response = receiver
		.recv_timeout(Duration::from_secs(20))
		.map_err(|_| "Remote provider registry reload timed out".to_string())?;
	if response.get("success").and_then(Value::as_bool) != Some(true) {
		let error = response
			.get("error")
			.and_then(Value::as_str)
			.unwrap_or("Remote provider registry reload failed");
		return Err(error.to_string());
	}
	Ok(())
}

fn provision_and_refresh_online_remotes(app: &AppHandle) {
	let state = app.state::<BridgeState>();
	let local_agent_dir = match agent_dir() {
		Ok(path) => path,
		Err(error) => {
			log_file(&format!("remote provider provisioning skipped: {error}"));
			return;
		}
	};
	for (cwd, config) in online_remote_workspaces(state.inner()) {
		let control_socket = lock_ok(&state.remote_runtimes)
			.get(&cwd)
			.map(|runtime| runtime.control_socket.clone())
			.unwrap_or_else(|| remote::environment_control_socket_path(&config));
		match remote::provision_remote_provider_config(&config, &control_socket, &local_agent_dir) {
			Ok(result) => {
				let status = result
					.get("status")
					.and_then(Value::as_str)
					.unwrap_or("unknown");
				let providers = result
					.get("personalProviderCount")
					.and_then(Value::as_u64)
					.unwrap_or(0);
				let credentials = result
					.get("credentialCount")
					.and_then(Value::as_u64)
					.unwrap_or(0);
				log_file(&format!(
					"remote provider provisioning ok: cwd={} status={} providers={} credentials={}",
					cwd, status, providers, credentials
				));
				if let Err(error) = reload_remote_provider_registry(state.inner(), &cwd) {
					log_file(&format!(
						"remote provider provisioning refresh warning: cwd={} error={}",
						cwd, error
					));
				}
			}
			Err(error) => {
				log_file(&format!(
					"remote provider provisioning warning: cwd={} error={}",
					cwd, error
				));
			}
		}
	}
}

fn schedule_remote_provider_provisioning(app: &AppHandle, delay: Duration) {
	let state = app.state::<BridgeState>();
	{
		let mut lane = lock_ok(&state.remote_provisioning);
		lane.generation = lane.generation.wrapping_add(1);
		if lane.running {
			return;
		}
		lane.running = true;
	}
	let worker_app = app.clone();
	tauri::async_runtime::spawn(async move {
		if !delay.is_zero() {
			tokio::time::sleep(delay).await;
		}
		loop {
			let generation = {
				let state = worker_app.state::<BridgeState>();
				let generation = lock_ok(&state.remote_provisioning).generation;
				generation
			};
			let blocking_app = worker_app.clone();
			let _ = tauri::async_runtime::spawn_blocking(move || {
				provision_and_refresh_online_remotes(&blocking_app);
			})
			.await;
			let state = worker_app.state::<BridgeState>();
			let mut lane = lock_ok(&state.remote_provisioning);
			if lane.generation == generation {
				lane.running = false;
				break;
			}
		}
	});
}

fn maybe_schedule_model_config_sync(app: &AppHandle, cwd: &str, frame: &Value) {
	if remote::is_remote_workspace_key(cwd)
		|| frame.get("type").and_then(Value::as_str) != Some("response")
		|| frame.get("success").and_then(Value::as_bool) != Some(true)
	{
		return;
	}
	let command = frame.get("command").and_then(Value::as_str).unwrap_or("");
	if matches!(
		command,
		"set_model" | "cycle_model" | "set_thinking_level" | "cycle_thinking_level"
	) {
		// SettingsManager persists the default before responding. This short
		// delay lets its queued file write settle before the source snapshot.
		schedule_remote_provider_provisioning(app, Duration::from_millis(75));
	}
}

fn remote_server_asset_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let candidates = [
		app.path()
			.resource_dir()
			.ok()
			.map(|path| path.join("remote")),
		Some(
			PathBuf::from(env!("CARGO_MANIFEST_DIR"))
				.join("..")
				.join("..")
				.join("dist")
				.join("remote"),
		),
	];
	candidates
		.into_iter()
		.flatten()
		.find(|path| path.join("manifest.json").exists())
		.ok_or_else(|| {
			"Remote server package is missing. Rebuild the desktop application.".to_string()
		})
}

/// Run blocking SSH work (probes, uploads, installs) off the async runtime.
async fn run_blocking<T: Send + 'static>(
	task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
	tauri::async_runtime::spawn_blocking(task)
		.await
		.map_err(|e| format!("remote task failed: {e}"))?
}

fn log_provider_sync(context: &str, cwd: &str, result: Result<Value, String>) {
	match result {
		Ok(result) => log_file(&format!(
			"{context}: provider sync cwd={cwd} status={} providers={} credentials={}",
			result
				.get("status")
				.and_then(Value::as_str)
				.unwrap_or("unknown"),
			result
				.get("personalProviderCount")
				.and_then(Value::as_u64)
				.unwrap_or(0),
			result
				.get("credentialCount")
				.and_then(Value::as_u64)
				.unwrap_or(0)
		)),
		Err(error) => log_file(&format!(
			"{context}: provider sync failed cwd={cwd} (continuing): {error}"
		)),
	}
}

fn clear_remote_tunnels(state: &BridgeState, cwd: &str) {
	let mut runtimes = lock_ok(&state.remote_runtimes);
	if let Some(runtime) = runtimes.get_mut(cwd) {
		for (_, mut tunnel) in runtime.tunnels.drain() {
			let _ = tunnel.child.kill();
			let _ = tunnel.child.wait();
		}
	}
}

fn stop_remote_runtime(state: &BridgeState, cwd: &str) {
	let runtime = lock_ok(&state.remote_runtimes).remove(cwd);
	if let Some(mut runtime) = runtime {
		for (_, mut tunnel) in runtime.tunnels.drain() {
			let _ = tunnel.child.kill();
			let _ = tunnel.child.wait();
		}
		if let Some(mut tunnel) = runtime.gateway_tunnel.take() {
			let _ = tunnel.kill();
			let _ = tunnel.wait();
		}
		if let Some(socket) = runtime.gateway_local_socket.take() {
			let _ = std::fs::remove_file(socket);
		}
	}
	if let Some(channel) = lock_ok(&state.channels).remove(cwd) {
		channel.close();
	}
}

/// Warm one SSH master per configured remote environment in the background.
/// The first workspace click can then reuse an already-authenticated transport.
pub fn warm_remote_transports(app: AppHandle) {
	let configs = {
		let state = app.state::<BridgeState>();
		let configs = lock_ok(&state.remote_workspaces)
			.values()
			.cloned()
			.collect::<Vec<_>>();
		configs
	};
	thread::spawn(move || {
		let mut warmed = HashSet::new();
		for config in configs {
			let socket = remote::environment_control_socket_path(&config);
			if !warmed.insert(socket.clone()) {
				continue;
			}
			if let Err(error) = remote::ensure_control_master(&config, &socket) {
				log_file(&format!(
					"warm_remote_transports: target={} error={error}",
					config.ssh_target
				));
			}
		}
	});
}

/// Drop every gateway channel and kill every legacy sidecar — used right
/// before an update replaces the app bundle.
pub fn shutdown_all_agents(state: &BridgeState) {
	for (_, channel) in lock_ok(&state.channels).drain() {
		channel.close();
	}
	let cwds: Vec<String> = lock_ok(&state.sidecars).keys().cloned().collect();
	for cwd in cwds {
		kill_sidecar_for_cwd(state, &cwd);
	}
}

/// Kill all sidecars for a given window (by active cwd).
pub fn kill_sidecar_for_window(state: &BridgeState, window_label: &str) {
	let cwd = {
		let active = lock_ok(&state.active);
		active.get(window_label).cloned()
	};
	if let Some(cwd) = cwd {
		// Remove this window from active map.
		{
			let mut active = lock_ok(&state.active);
			active.remove(window_label);
		}
		// Check if any other window is using this sidecar.
		let still_in_use = {
			let active = lock_ok(&state.active);
			active.values().any(|c| c == &cwd)
		};
		if !still_in_use {
			if cwd_has_runnable_scheduled_tasks(&cwd) {
				log_file(&format!(
					"kill_sidecar_for_window: keeping scheduled sidecar for {}",
					cwd
				));
			} else {
				kill_sidecar_for_cwd(state, &cwd);
			}
		}
	}
}

/// Send a fire-and-forget JSON-RPC command (no args) to every running sidecar.
///
/// Provider credentials live in the shared `~/.pizza/agent/auth.json`, which is
/// edited out-of-band by `set_provider_api_key` / `remove_provider_api_key`.
/// Each sidecar caches credentials in memory and only re-reads the file on
/// explicit reload, so after such an edit we must tell every sidecar to reload
/// — otherwise a subsequent model switch resolves auth from the stale cache and
/// silently falls back to an environment-variable key (the wrong token).
fn broadcast_to_all_sidecars(state: &BridgeState, command_type: &str) {
	let line = serde_json::json!({ "id": uuid::Uuid::new_v4().to_string(), "type": command_type });
	let payload = match serde_json::to_string(&line) {
		Ok(s) => s,
		Err(e) => {
			log_file(&format!("broadcast_to_all_sidecars: serialize failed: {e}"));
			return;
		}
	};
	let mut sent = 0;
	let mut failed = Vec::new();
	{
		let mut sidecars = state.sidecars.lock().unwrap();
		for (cwd, sidecar) in sidecars.iter_mut() {
			// A write error here means the sidecar pipe is broken (process died).
			// The reader thread will reap it; we just log and move on.
			let result = (|| -> std::io::Result<()> {
				use std::io::Write;
				sidecar.stdin.write_all(payload.as_bytes())?;
				sidecar.stdin.write_all(b"\n")?;
				sidecar.stdin.flush()?;
				Ok(())
			})();
			if result.is_ok() {
				sent += 1;
			} else {
				failed.push(cwd.clone());
			}
		}
	}
	log_file(&format!(
		"broadcast_to_all_sidecars: command={} sent_to={} failed={:?}",
		command_type, sent, failed
	));
}

/// Fire-and-forget a no-arg RPC command to every gateway channel (the
/// gateway-mode equivalent of broadcast_to_all_sidecars). Each channel.rpc()
/// blocks waiting for a per-command response, so runs on spawn_blocking and
/// the result is ignored — this is best-effort fan-out (e.g. reload_providers
/// after editing auth.json).
async fn broadcast_to_all_channels(state: &BridgeState, command_type: &str) {
	let entries: Vec<(String, gateway_channel::GatewayChannel)> = lock_ok(&state.channels)
		.iter()
		.map(|(cwd, channel)| (gateway_workspace_for_cwd(state, cwd), channel.clone()))
		.collect();
	let mut sent = 0;
	for (workspace, channel) in entries {
		let cmd_type = command_type.to_string();
		let id = uuid::Uuid::new_v4().to_string();
		let result = tauri::async_runtime::spawn_blocking(move || {
			channel.rpc(
				&workspace,
				serde_json::json!({ "id": id, "type": cmd_type }),
			)
		})
		.await;
		if result.map(|r| r.is_ok()).unwrap_or(false) {
			sent += 1;
		}
	}
	log_file(&format!(
		"broadcast_to_all_channels: command={} sent_to={}",
		command_type, sent
	));
}

fn home_dir() -> Option<PathBuf> {
	// Windows sets USERPROFILE, not HOME — fall back so ~/.pizza paths
	// resolve on every platform.
	std::env::var("HOME")
		.or_else(|_| std::env::var("USERPROFILE"))
		.ok()
		.map(PathBuf::from)
		.filter(|p| !p.as_os_str().is_empty())
}

/// Expand a leading `~` to the user's home directory. Other `~` positions
/// (and `~user` forms) are left untouched.
fn expand_tilde(path: &str) -> String {
	if !path.starts_with("~") {
		return path.to_string();
	}
	match home_dir() {
		Some(home) => {
			let rest = path[1..].trim_start_matches(['/', '\\']);
			if rest.is_empty() {
				home.to_string_lossy().to_string()
			} else {
				home.join(rest).to_string_lossy().to_string()
			}
		}
		None => path.to_string(),
	}
}

fn normalize_path_for_compare(path: &str) -> String {
	let normalized = std::fs::canonicalize(path)
		.unwrap_or_else(|_| PathBuf::from(path))
		.to_string_lossy()
		.replace('\\', "/");
	if cfg!(windows) {
		normalized.to_lowercase()
	} else {
		normalized
	}
}

fn persistent_chat_cwd() -> Option<String> {
	home_dir().map(|home| {
		home.join(".pizza")
			.join("main")
			.to_string_lossy()
			.to_string()
	})
}

fn is_persistent_chat_cwd(cwd: &str) -> bool {
	persistent_chat_cwd()
		.map(|main| normalize_path_for_compare(cwd) == normalize_path_for_compare(&main))
		.unwrap_or(false)
}

fn main_agent_lock_path() -> Option<PathBuf> {
	persistent_chat_cwd().map(|cwd| PathBuf::from(cwd).join(".lock"))
}

fn read_main_agent_lock_pid() -> Option<(PathBuf, u32)> {
	let lock_path = main_agent_lock_path()?;
	let raw = std::fs::read_to_string(&lock_path).ok()?;
	let pid = raw.trim().parse::<u32>().ok()?;
	Some((lock_path, pid))
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
	Command::new("kill")
		.args(["-0", &pid.to_string()])
		.status()
		.map(|status| status.success())
		.unwrap_or(false)
}

#[cfg(windows)]
fn is_process_alive(pid: u32) -> bool {
	// `tasklist /FI "PID eq <pid>" /FO CSV /NH` prints one CSV line per
	// matching process, or "INFO: No tasks..." when the pid is dead.
	Command::new("tasklist")
		.args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
		.output()
		.map(|out| {
			String::from_utf8_lossy(&out.stdout).lines().any(|line| {
				line.split(',')
					.nth(1)
					.map(|field| field.trim_matches('"') == pid.to_string())
					.unwrap_or(false)
			})
		})
		.unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
fn is_process_alive(_pid: u32) -> bool {
	false
}

#[cfg(unix)]
fn process_command(pid: u32) -> Option<String> {
	let pid_arg = pid.to_string();
	let output = Command::new("ps")
		.args(["-p", &pid_arg, "-o", "command="])
		.output()
		.ok()?;
	if !output.status.success() {
		return None;
	}
	let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
	if command.is_empty() {
		None
	} else {
		Some(command)
	}
}

#[cfg(windows)]
fn process_command(pid: u32) -> Option<String> {
	let output = Command::new("powershell")
		.args([
			"-NoProfile",
			"-Command",
			&format!(
				"(Get-CimInstance Win32_Process -Filter 'ProcessId={}').CommandLine",
				pid
			),
		])
		.output()
		.ok()?;
	if !output.status.success() {
		return None;
	}
	let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
	if command.is_empty() {
		None
	} else {
		Some(command)
	}
}

#[cfg(not(any(unix, windows)))]
fn process_command(_pid: u32) -> Option<String> {
	None
}

fn is_probably_pizza_main_agent(command: &str) -> bool {
	let lower = command.to_ascii_lowercase();
	command.contains("--main")
		&& (lower.contains("pizza")
			|| lower.contains("src/cli")
			|| lower.contains("src/main")
			|| lower.contains("dist/cli")
			|| lower.contains("dist/main"))
}

fn current_main_agent_status() -> MainAgentStatus {
	let lock_path = main_agent_lock_path().unwrap_or_else(|| PathBuf::from("~/.pizza/main/.lock"));
	let lock_path_str = lock_path.to_string_lossy().to_string();
	let Some((_, pid)) = read_main_agent_lock_pid() else {
		return MainAgentStatus {
			running: false,
			pid: None,
			command: None,
			lock_path: lock_path_str,
		};
	};
	let running = is_process_alive(pid);
	let command = if running { process_command(pid) } else { None };
	MainAgentStatus {
		running,
		pid: Some(pid),
		command,
		lock_path: lock_path_str,
	}
}

#[tauri::command]
pub fn main_agent_status() -> Result<MainAgentStatus, String> {
	Ok(current_main_agent_status())
}

#[tauri::command]
pub async fn stop_main_agent() -> Result<MainAgentStatus, String> {
	let Some((lock_path, pid)) = read_main_agent_lock_pid() else {
		return Ok(current_main_agent_status());
	};
	if !is_process_alive(pid) {
		let _ = std::fs::remove_file(&lock_path);
		return Ok(current_main_agent_status());
	}
	let command = process_command(pid).unwrap_or_default();
	if !is_probably_pizza_main_agent(&command) {
		return Err(format!(
			"The process referenced by the lock file does not look like the Pizza main agent; aborting. PID: {}, command: {}",
			pid,
			if command.is_empty() {
				"<unknown>"
			} else {
				&command
			}
		));
	}

	#[cfg(unix)]
	let stop_result = Command::new("kill")
		.args(["-TERM", &pid.to_string()])
		.status()
		.map(|status| status.success())
		.unwrap_or(false);

	#[cfg(not(unix))]
	let stop_result = Command::new("taskkill")
		// /F is required — the pizza sidecar is a console-less child process
		// and ignores the graceful WM_CLOSE that plain taskkill sends.
		.args(["/PID", &pid.to_string(), "/T", "/F"])
		.status()
		.map(|status| status.success())
		.unwrap_or(false);

	if !stop_result {
		return Err(format!(
			"Failed to stop the old main agent process (PID {})",
			pid
		));
	}

	for _ in 0..30 {
		if !is_process_alive(pid) {
			if std::fs::read_to_string(&lock_path)
				.map(|raw| raw.trim() == pid.to_string())
				.unwrap_or(false)
			{
				let _ = std::fs::remove_file(&lock_path);
			}
			return Ok(current_main_agent_status());
		}
		tokio::time::sleep(Duration::from_millis(100)).await;
	}

	Err(format!(
		"Asked the old main agent to exit, but PID {} is still running. Close the old Pizza window manually and try again.",
		pid
	))
}

fn workspace_meta_root() -> Option<PathBuf> {
	home_dir().map(|home| home.join(".pizza").join("agent").join("workspaces"))
}

fn scheduler_tasks_path_for_workspace(workspace_id: &str) -> Option<PathBuf> {
	home_dir().map(|home| {
		home.join(".pizza")
			.join("workspaces")
			.join(workspace_id)
			.join("scheduler")
			.join("tasks.json")
	})
}

fn scheduler_tasks_path_for_cwd(cwd: &str) -> Option<PathBuf> {
	if is_persistent_chat_cwd(cwd) {
		return home_dir().map(|home| {
			home.join(".pizza")
				.join("main")
				.join("scheduler")
				.join("tasks.json")
		});
	}
	let target = normalize_path_for_compare(cwd);
	let root = workspace_meta_root()?;
	let entries = std::fs::read_dir(root).ok()?;
	for entry in entries.flatten() {
		let meta_path = entry.path().join("meta.json");
		let raw = match std::fs::read_to_string(meta_path) {
			Ok(raw) => raw,
			Err(_) => continue,
		};
		let meta: Value = match serde_json::from_str(&raw) {
			Ok(meta) => meta,
			Err(_) => continue,
		};
		let Some(meta_cwd) = meta.get("cwd").and_then(|v| v.as_str()) else {
			continue;
		};
		if normalize_path_for_compare(meta_cwd) != target {
			continue;
		}
		let Some(workspace_id) = meta.get("workspace_id").and_then(|v| v.as_str()) else {
			continue;
		};
		return scheduler_tasks_path_for_workspace(workspace_id);
	}
	None
}

fn task_target_is_supported(task: &Value) -> bool {
	let target = match task.get("sessionTarget") {
		Some(value) => value,
		None => return false,
	};
	match target.get("kind").and_then(|v| v.as_str()) {
		Some("new") => true,
		Some("pinned") => target
			.get("sessionId")
			.and_then(|v| v.as_str())
			.map(|s| !s.is_empty())
			.unwrap_or(false),
		_ => false,
	}
}

fn tasks_file_has_runnable_enabled_task(path: &PathBuf) -> bool {
	let raw = match std::fs::read_to_string(path) {
		Ok(raw) => raw,
		Err(_) => return false,
	};
	let parsed: Value = match serde_json::from_str(&raw) {
		Ok(value) => value,
		Err(_) => return false,
	};
	let tasks = parsed
		.get("tasks")
		.and_then(|v| v.as_array())
		.or_else(|| parsed.as_array());
	let Some(tasks) = tasks else {
		return false;
	};
	tasks.iter().any(|task| {
		task.get("enabled")
			.and_then(|v| v.as_bool())
			.unwrap_or(false)
			&& task_target_is_supported(task)
	})
}

fn cwd_has_runnable_scheduled_tasks(cwd: &str) -> bool {
	scheduler_tasks_path_for_cwd(cwd)
		.map(|path| tasks_file_has_runnable_enabled_task(&path))
		.unwrap_or(false)
}

fn scheduled_cwds_to_keep_alive() -> Vec<String> {
	let mut out = Vec::new();
	if let Some(main_cwd) = persistent_chat_cwd() {
		if cwd_has_runnable_scheduled_tasks(&main_cwd) {
			out.push(main_cwd);
		}
	}
	let Some(root) = workspace_meta_root() else {
		return out;
	};
	let entries = match std::fs::read_dir(root) {
		Ok(entries) => entries,
		Err(_) => return out,
	};
	for entry in entries.flatten() {
		let meta_path = entry.path().join("meta.json");
		let raw = match std::fs::read_to_string(meta_path) {
			Ok(raw) => raw,
			Err(_) => continue,
		};
		let meta: Value = match serde_json::from_str(&raw) {
			Ok(meta) => meta,
			Err(_) => continue,
		};
		let Some(cwd) = meta.get("cwd").and_then(|v| v.as_str()) else {
			continue;
		};
		let Some(workspace_id) = meta.get("workspace_id").and_then(|v| v.as_str()) else {
			continue;
		};
		let Some(tasks_path) = scheduler_tasks_path_for_workspace(workspace_id) else {
			continue;
		};
		if tasks_file_has_runnable_enabled_task(&tasks_path)
			&& !out.iter().any(|existing| {
				normalize_path_for_compare(existing) == normalize_path_for_compare(cwd)
			}) {
			out.push(cwd.to_string());
		}
	}
	out
}

fn write_rpc_line(sidecar: &mut SidecarEntry, value: Value) -> Result<(), String> {
	let line = serde_json::to_string(&value).map_err(|e| e.to_string())?;
	sidecar
		.stdin
		.write_all(line.as_bytes())
		.map_err(|e| format!("write: {e}"))?;
	sidecar
		.stdin
		.write_all(b"\n")
		.map_err(|e| format!("write nl: {e}"))?;
	sidecar.stdin.flush().map_err(|e| format!("flush: {e}"))?;
	Ok(())
}

fn ensure_remote_tunnel(
	state: &BridgeState,
	cwd: &str,
	config: &remote::RemoteWorkspaceConfig,
	remote_port: u16,
) -> Result<u16, String> {
	{
		let mut runtimes = lock_ok(&state.remote_runtimes);
		let runtime = runtimes
			.get_mut(cwd)
			.ok_or_else(|| "Remote SSH runtime is not running".to_string())?;
		if let Some(tunnel) = runtime.tunnels.get_mut(&remote_port) {
			if tunnel
				.child
				.try_wait()
				.map_err(|e| e.to_string())?
				.is_none()
			{
				return Ok(tunnel.local_port);
			}
			let mut dead = runtime
				.tunnels
				.remove(&remote_port)
				.expect("checked tunnel");
			let _ = dead.child.wait();
		}
	}

	let control_socket = {
		let runtimes = lock_ok(&state.remote_runtimes);
		runtimes
			.get(cwd)
			.map(|runtime| runtime.control_socket.clone())
			.ok_or_else(|| "Remote SSH runtime is not running".to_string())?
	};
	let local_port = remote::allocate_local_port()?;
	let child = remote::spawn_tunnel(config, &control_socket, local_port, remote_port)?;
	let mut runtimes = lock_ok(&state.remote_runtimes);
	let runtime = runtimes
		.get_mut(cwd)
		.ok_or_else(|| "Remote SSH runtime stopped during tunnel creation".to_string())?;
	if let Some(existing) = runtime.tunnels.get(&remote_port) {
		return Ok(existing.local_port);
	}
	runtime
		.tunnels
		.insert(remote_port, RemoteTunnel { local_port, child });
	log_file(&format!(
		"remote tunnel ready: cwd={} remote_port={} local_port={}",
		cwd, remote_port, local_port
	));
	Ok(local_port)
}

fn rewrite_remote_port_field(
	state: &BridgeState,
	cwd: &str,
	config: &remote::RemoteWorkspaceConfig,
	value: &mut Value,
	pointer: &str,
) {
	let Some(port_value) = value.pointer_mut(pointer) else {
		return;
	};
	let Some(port) = port_value.as_u64() else {
		return;
	};
	if port == 0 || port > u16::MAX as u64 {
		return;
	}
	match ensure_remote_tunnel(state, cwd, config, port as u16) {
		Ok(local_port) => {
			*port_value = Value::Number(local_port.into());
		}
		Err(error) => {
			log_file(&format!(
				"remote tunnel setup failed: cwd={} pointer={} port={} error={}",
				cwd, pointer, port, error
			));
		}
	}
}

fn rewrite_remote_service_ports(state: &BridgeState, cwd: &str, value: &mut Value) {
	let Some(config) = remote_workspace_config(state, cwd) else {
		return;
	};
	rewrite_remote_port_field(state, cwd, &config, value, "/data/ptyPort");
	rewrite_remote_port_field(state, cwd, &config, value, "/data/frame/wsPort");
}

/// Persist a validated SSH workspace and return the same metadata shape as
/// `list_workspaces`.
#[tauri::command]
pub async fn add_remote_workspace(
	state: tauri::State<'_, BridgeState>,
	input: remote::AddRemoteWorkspaceInput,
) -> Result<Value, String> {
	let config = tauri::async_runtime::spawn_blocking(move || remote::add_remote_workspace(input))
		.await
		.map_err(|e| format!("remote workspace probe task failed: {e}"))??;
	let existing = {
		let workspaces = lock_ok(&state.remote_workspaces);
		workspaces
			.values()
			.find(|candidate| same_remote_workspace(candidate, &config))
			.cloned()
	};
	if let Some(existing) = existing {
		let cwd = remote::workspace_key(&existing.id);
		log_file(&format!(
			"add_remote_workspace: reusing existing cwd={} target={} path={}",
			cwd, existing.ssh_target, existing.remote_path
		));
		return Ok(remote::remote_workspace_meta(&existing));
	}
	let cwd = remote::workspace_key(&config.id);
	let meta = remote::remote_workspace_meta(&config);
	{
		let mut workspaces = lock_ok(&state.remote_workspaces);
		workspaces.insert(cwd.clone(), config.clone());
		if let Err(error) = remote::save_remote_workspaces(&workspaces) {
			workspaces.remove(&cwd);
			return Err(error);
		}
	}
	log_file(&format!(
		"add_remote_workspace: cwd={} target={} path={}",
		cwd, config.ssh_target, config.remote_path
	));
	Ok(meta)
}

#[tauri::command]
pub async fn browse_remote_directories(
	input: remote::RemoteSshInput,
	path: Option<String>,
) -> Result<Value, String> {
	let listing = tauri::async_runtime::spawn_blocking(move || {
		remote::browse_remote_directories(input, path)
	})
	.await
	.map_err(|e| format!("remote directory browse task failed: {e}"))??;
	serde_json::to_value(listing).map_err(|e| e.to_string())
}

async fn remote_fs_request(
	state: &BridgeState,
	cwd: &str,
	method: &str,
	params: Value,
) -> Result<Option<Value>, String> {
	if !remote::is_remote_workspace_key(cwd) {
		return Ok(None);
	}
	let config = remote_workspace_config(state, cwd)
		.ok_or_else(|| format!("Remote workspace is not registered: {cwd}"))?;
	let control_socket = lock_ok(&state.remote_runtimes)
		.get(cwd)
		.map(|runtime| runtime.control_socket.clone())
		.unwrap_or_else(|| remote::environment_control_socket_path(&config));
	let request = serde_json::json!({
		"id": uuid::Uuid::new_v4().to_string(),
		"method": method,
		"params": params
	});
	let value = tauri::async_runtime::spawn_blocking(move || {
		remote::run_remote_fs_request(&config, &control_socket, request)
	})
	.await
	.map_err(|e| format!("remote filesystem task failed: {e}"))??;
	Ok(Some(value))
}

fn save_remote_upload(
	state: &BridgeState,
	cwd: &str,
	filename: &str,
	mime_type: &str,
	bytes: &[u8],
) -> Result<FileAttachmentInfo, String> {
	let config = remote_workspace_config(state, cwd)
		.ok_or_else(|| format!("Remote workspace is not registered: {cwd}"))?;
	let control_socket = lock_ok(&state.remote_runtimes)
		.get(cwd)
		.map(|runtime| runtime.control_socket.clone())
		.unwrap_or_else(|| remote::environment_control_socket_path(&config));
	let safe_name = sanitize_upload_filename(filename);
	let stored_name = format!("{}-{}", uuid::Uuid::new_v4(), safe_name);
	let relative_path = format!(".pizza/uploads/{stored_name}");
	let remote_path = format!(
		"{}/{}",
		config.remote_path.trim_end_matches('/'),
		relative_path
	);
	remote::upload_bytes(&config, &control_socket, &remote_path, bytes)?;
	Ok(FileAttachmentInfo {
		kind: "file",
		absolute_path: remote_path.clone(),
		relative_path,
		mime_type: guess_mime_type(&PathBuf::from(&remote_path), mime_type),
		name: filename.to_string(),
		size: bytes.len() as u64,
	})
}

fn spawn_background_sidecar(
	app: AppHandle,
	state: &BridgeState,
	cwd: String,
) -> Result<(), String> {
	if crate::updater::is_installing() {
		return Err("Pizza is installing an update".into());
	}
	if !std::path::Path::new(&cwd).is_dir() {
		return Err(format!("Directory does not exist: {}", cwd));
	}
	{
		let mut sidecars = state.sidecars.lock().unwrap();
		if let Some(sidecar) = sidecars.get_mut(&cwd) {
			let _ = write_rpc_line(
				sidecar,
				serde_json::json!({ "id": uuid::Uuid::new_v4().to_string(), "type": "get_state" }),
			);
			return Ok(());
		}
	}

	let (program, mut args) = resolve_pizza_command(&app);
	if is_persistent_chat_cwd(&cwd) {
		args.push("--main".to_string());
	}
	let mut cmd = Command::new(&program);
	cmd.args(&args);
	cmd.current_dir(&cwd);
	cmd.stdin(Stdio::piped());
	cmd.stdout(Stdio::piped());
	cmd.stderr(Stdio::piped());
	cmd.env("PATH", resolve_shell_path());
	log_file(&format!(
		"scheduler_guard: spawning {} {:?} cwd={}",
		program, args, cwd
	));
	let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {e}"))?;
	let stdin = child.stdin.take().ok_or("no stdin")?;
	let stdout = child.stdout.take().ok_or("no stdout")?;
	let stderr = child.stderr.take().ok_or("no stderr")?;
	let pid = child.id();

	let stderr_cwd = cwd.clone();
	thread::spawn(move || {
		let mut reader = BufReader::new(stderr);
		let mut bytes = Vec::new();
		let _ = reader.read_to_end(&mut bytes);
		let text = String::from_utf8_lossy(&bytes).trim().to_string();
		if !text.is_empty() {
			log_file(&format!(
				"scheduler_guard stderr [cwd={}]: {}",
				stderr_cwd, text
			));
		}
	});

	{
		let mut sidecars = state.sidecars.lock().unwrap();
		sidecars.insert(cwd.clone(), SidecarEntry { child, stdin });
		if let Some(sidecar) = sidecars.get_mut(&cwd) {
			let _ = write_rpc_line(
				sidecar,
				serde_json::json!({ "id": uuid::Uuid::new_v4().to_string(), "type": "get_state" }),
			);
		}
	}

	let reader_cwd = cwd.clone();
	std::thread::spawn(move || {
		log_file(&format!(
			"reader thread: started for scheduler cwd={}",
			reader_cwd
		));
		let reader = BufReader::new(stdout);
		for line in reader.lines() {
			match line {
				Ok(line) => {
					let trimmed = line.trim();
					if trimmed.is_empty() || !trimmed.starts_with('{') {
						continue;
					}
					let mut parsed: Value = match serde_json::from_str(trimmed) {
						Ok(v) => v,
						Err(_) => continue,
					};
					log_file(&format!("sidecar stdout [cwd={}]: {}", reader_cwd, trimmed));
					let app_ref = &app;
					let active = app_ref.state::<BridgeState>();
					let active_map = lock_ok(&active.active);
					let etype = parsed
						.get("type")
						.and_then(|t| t.as_str())
						.unwrap_or("")
						.to_string();
					emit_to_pet_window(app_ref, &parsed, &reader_cwd);
					if etype == "response" {
						if let Some(obj) = parsed.as_object_mut() {
							obj.insert("_cwd".to_string(), Value::String(reader_cwd.clone()));
						}
					}
					for (label, _ac_cwd) in active_map.iter() {
						if let Some(win) = app_ref.get_webview_window(label) {
							let mut tagged = parsed.clone();
							if let Some(obj) = tagged.as_object_mut() {
								obj.insert("_cwd".to_string(), Value::String(reader_cwd.clone()));
							}
							match etype.as_str() {
								"response" => {
									let _ = win.emit("rpc_response", tagged);
								}
								"extension_ui_request" => {
									let _ = win.emit("extension_ui_request", tagged);
								}
								_ => {
									let _ = win.emit("rpc_event", tagged);
								}
							}
						}
					}
				}
				Err(e) => {
					log_file(&format!("reader error [cwd={}]: {e}", reader_cwd));
					break;
				}
			}
		}
		log_file(&format!(
			"reader thread: EOF for scheduler cwd={}",
			reader_cwd
		));
		let state = app.state::<BridgeState>();
		let mut sidecars = state.sidecars.lock().unwrap();
		if let Some(mut entry) = sidecars.remove(&reader_cwd) {
			drop(entry.stdin);
			let _ = entry.child.wait();
			log_file(&format!(
				"reader thread: reaped scheduler sidecar pid={:?} cwd={}",
				pid, reader_cwd
			));
		}
	});

	log_file(&format!(
		"scheduler_guard: started sidecar pid={:?} cwd={}",
		pid, cwd
	));
	Ok(())
}

pub fn start_scheduler_sidecar_guard(app: AppHandle) {
	// Gateway mode: the gateway daemon owns scheduled workspaces — its
	// scheduler guard scans tasks.json scopes, spawns pooled agents for any
	// scheduled cwd, and pins them against idle eviction. Spawning raw
	// sidecars here would produce a SECOND agent per workspace (invisible to
	// the pool) whose pid dies with the GUI's memory — the orphan-process /
	// double-SchedulerEngine bug. Legacy sidecar mode still needs the loop.
	if gateway_mode_enabled() {
		log_file("scheduler_guard: gateway mode — guard is owned by the gateway daemon; not spawning sidecars");
		return;
	}
	thread::spawn(move || loop {
		let cwds = scheduled_cwds_to_keep_alive();
		for cwd in cwds {
			if let Some(main_cwd) = persistent_chat_cwd() {
				if normalize_path_for_compare(&cwd) == normalize_path_for_compare(&main_cwd) {
					continue;
				}
			}
			let already_running = {
				let state = app.state::<BridgeState>();
				let sidecars = state.sidecars.lock().unwrap();
				sidecars.contains_key(&cwd)
			};
			if already_running {
				continue;
			}
			let state = app.state::<BridgeState>();
			if let Err(e) = spawn_background_sidecar(app.clone(), state.inner(), cwd.clone()) {
				log_file(&format!(
					"scheduler_guard: failed to start cwd={}: {}",
					cwd, e
				));
			}
		}
		thread::sleep(Duration::from_secs(15));
	});
}

/// One-shot init: spawns sidecar for the calling window, sends get_state. Returns state JSON.
/// If a sidecar for this cwd already exists, just switches the active pointer (no restart).
/// `cwd` is the working directory for the pizza rpc process (the user's project).
#[tauri::command]
pub async fn init_sidecar(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	cwd: Option<String>,
) -> Result<String, String> {
	let label = window.label().to_string();
	init_workspace(window, state, cwd, label).await
}

async fn init_workspace(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	cwd: Option<String>,
	window_label: String,
) -> Result<String, String> {
	log_file(&format!("init_sidecar: start, window={}", window_label));
	if crate::updater::is_installing() {
		return Err("Pizza is installing an update and will restart shortly".into());
	}

	let cwd = cwd.unwrap_or_else(|| {
		PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("..")
			.join("..")
			.canonicalize()
			.map(|p| p.to_string_lossy().to_string())
			.unwrap_or_else(|_| ".".to_string())
	});
	// Expand ~ to home directory.
	let cwd = expand_tilde(&cwd);
	log_file(&format!("init_sidecar: cwd={}", cwd));

	if remote::is_remote_workspace_key(&cwd) {
		return init_remote_sidecar(window, state, window_label, cwd).await;
	}

	// The persistent Chat workspace (~/.pizza/main) is auto-created on first
	// launch. It is the default workspace the desktop app boots into, so it
	// must always exist — unlike user-selected project directories, which are
	// expected to be present already.
	let is_persistent_chat = is_persistent_chat_cwd(&cwd);
	if is_persistent_chat && !std::path::Path::new(&cwd).is_dir() {
		log_file(&format!(
			"init_sidecar: creating persistent Chat workspace at {}",
			cwd
		));
		if let Err(e) = std::fs::create_dir_all(&cwd) {
			return Err(format!("Failed to create Chat workspace {}: {}", cwd, e));
		}
	}

	// Validate that the cwd directory exists before attempting to spawn.
	if !std::path::Path::new(&cwd).is_dir() {
		return Err(format!("Directory does not exist: {}", cwd));
	}

	// Gateway-mode opt-in: route through the broker instead of spawning a sidecar.
	// Default OFF — current spawn behavior is unchanged until a GUI smoke test flips it.
	if gateway_mode_enabled() {
		return init_sidecar_via_gateway(window.app_handle().clone(), state, window_label, cwd)
			.await;
	}

	// Check if sidecar for this cwd already exists.
	let already_running = {
		let sidecars = state.sidecars.lock().unwrap();
		sidecars.contains_key(&cwd)
	};

	if already_running {
		// Just switch active pointer.
		log_file(&format!(
			"init_sidecar: sidecar already running for cwd={}, switching active",
			cwd
		));
		{
			let mut active = lock_ok(&state.active);
			active.insert(window_label.clone(), cwd.clone());
		}
		// Send get_state to get current state.
		let id = uuid::Uuid::new_v4().to_string();
		let cmd = serde_json::json!({ "id": id, "type": "get_state" });
		let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
		{
			let mut sidecars = state.sidecars.lock().unwrap();
			let sidecar = sidecars.get_mut(&cwd).ok_or("Sidecar disappeared")?;
			use std::io::Write;
			sidecar
				.stdin
				.write_all(line.as_bytes())
				.map_err(|e| format!("write: {e}"))?;
			sidecar
				.stdin
				.write_all(b"\n")
				.map_err(|e| format!("write nl: {e}"))?;
			sidecar.stdin.flush().map_err(|e| format!("flush: {e}"))?;
		}
		// We can't easily read the response synchronously here since the reader
		// thread is already consuming stdout. The frontend will get the state
		// via the rpc_response event. Return empty state.
		log_file("init_sidecar: switched, returning empty (state will come via event)");
		return Ok(serde_json::json!({}).to_string());
	}

	// Multi-sidecar: never kill the old sidecar on switch — it persists.
	// Just update the active workspace mapping for this window (done below).

	let (program, mut args) = resolve_pizza_command(window.app_handle());
	// When the workspace is the persistent Chat (~/.pizza/main), launch pizza
	// in main-agent mode so it initializes the soul file + long-term memory
	// scaffold and injects the main-agent guidelines into the system prompt.
	if is_persistent_chat {
		args.push("--main".to_string());
	}
	let mut cmd = Command::new(&program);
	cmd.args(&args);
	cmd.current_dir(&cwd);
	cmd.stdin(Stdio::piped());
	cmd.stdout(Stdio::piped());
	// Capture the sidecar's stderr so we can surface its real diagnostic when
	// it crashes immediately. Without this, a sidecar that emits its only
	// error to stderr (e.g. "Another main agent instance is already running")
	// fails invisibly inside the .app bundle — the GUI sees only an opaque
	// exit code with no clue about what went wrong.
	cmd.stderr(Stdio::piped());
	// GUI-launched processes inherit launchd's minimal PATH and never source the
	// user's shell rc files, so homebrew/cargo/nvm etc. would be missing. Capture
	// the login-shell PATH once and pass it to the sidecar explicitly.
	cmd.env("PATH", resolve_shell_path());
	log_file(&format!(
		"init_sidecar: sidecar PATH = {}",
		resolve_shell_path()
	));

	log_file(&format!("init_sidecar: spawning {} {:?}", program, args));
	let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {e}"))?;
	log_file(&format!("init_sidecar: pid={:?}", child.id()));
	let stdin = child.stdin.take().ok_or("no stdin")?;
	let stdout = child.stdout.take().ok_or("no stdout")?;
	// Drain stderr in a background thread and stash the output. The thread
	// reads until EOF (which happens when the child closes its stderr end on
	// exit). When we surface the "sidecar exited" error below, we wait for the
	// child to exit, then join this thread to read its captured bytes.
	let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
	let stderr_handle = child.stderr.take().ok_or("no stderr")?;
	let stderr_buf_for_thread = Arc::clone(&stderr_buf);
	let stderr_thread = thread::spawn(move || {
		let mut reader = BufReader::new(stderr_handle);
		let mut bytes = Vec::new();
		let _ = reader.read_to_end(&mut bytes);
		if let Ok(mut s) = stderr_buf_for_thread.lock() {
			s.push_str(&String::from_utf8_lossy(&bytes));
		}
	});

	// Send get_state BEFORE storing stdin (so we can read the response synchronously).
	log_file("init_sidecar: sending get_state");
	let id = uuid::Uuid::new_v4().to_string();
	let cmd = serde_json::json!({ "id": id, "type": "get_state" });
	let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
	{
		use std::io::Write;
		let mut stdin_ref = &stdin;
		stdin_ref
			.write_all(line.as_bytes())
			.map_err(|e| format!("write: {e}"))?;
		stdin_ref
			.write_all(b"\n")
			.map_err(|e| format!("write nl: {e}"))?;
		stdin_ref.flush().map_err(|e| format!("flush: {e}"))?;
	}
	log_file("init_sidecar: get_state sent, reading first response");

	// Read first line from stdout synchronously (the get_state response).
	let mut reader = BufReader::new(stdout);
	let mut first_line = String::new();
	let bytes_read = reader
		.read_line(&mut first_line)
		.map_err(|e| format!("read response: {e}"))?;
	log_file(&format!("init_sidecar: first line = {}", first_line.trim()));

	// If we got EOF (0 bytes) the sidecar died immediately. Check exit status
	// to surface a meaningful error instead of storing a dead sidecar that
	// would cause "Broken pipe" on the next write.
	if bytes_read == 0 {
		// Reap the child (with a short timeout) so the OS closes its stderr
		// end and the stderr drain thread can finish. try_wait() first to
		// avoid blocking when the child has already exited.
		let exit_status = match child.try_wait() {
			Ok(Some(s)) => Some(s),
			_ => match child.wait() {
				Ok(s) => Some(s),
				Err(e) => {
					log_file(&format!("init_sidecar: wait failed: {e}"));
					None
				}
			},
		};
		// The stderr drain thread reads until EOF, which fires when the child
		// closes its stderr (i.e. when wait() above reaps it). Give it a
		// moment to land its buffered bytes, then join.
		let _ = stderr_thread.join();

		let exit_info = match exit_status {
			Some(status) => format!(" ({})", status),
			None => String::new(),
		};
		// Append the captured stderr so the user sees *why* the sidecar died,
		// not just that it did. Trim to the tail to keep the error payload
		// bounded — startup failures almost always live in the last few KB.
		const MAX_STDERR_TAIL: usize = 4096;
		let stderr_suffix = match stderr_buf.lock() {
			Ok(s) => {
				let trimmed = s.trim();
				if trimmed.is_empty() {
					String::new()
				} else {
					let tail = if trimmed.len() > MAX_STDERR_TAIL {
						let from = trimmed.len() - MAX_STDERR_TAIL;
						let safe_from = trimmed
							.char_indices()
							.map(|(i, _)| i)
							.find(|&i| i >= from)
							.unwrap_or(from);
						&trimmed[safe_from..]
					} else {
						trimmed
					};
					format!("\n--- sidecar stderr ---\n{}\n--- end ---", tail)
				}
			}
			Err(_) => String::new(),
		};
		return Err(format!(
			"Sidecar exited immediately without responding{}{}",
			exit_info, stderr_suffix
		));
	}

	// Parse the response.
	let state_data: Value = {
		let trimmed = first_line.trim();
		if trimmed.starts_with('{') {
			serde_json::from_str(trimmed).unwrap_or(Value::Null)
		} else {
			Value::Null
		}
	};

	// Store sidecar keyed by cwd.
	{
		let mut sidecars = state.sidecars.lock().unwrap();
		sidecars.insert(cwd.clone(), SidecarEntry { child, stdin });
	}

	// Set active cwd for this window.
	{
		let mut active = lock_ok(&state.active);
		active.insert(window_label.clone(), cwd.clone());
	}

	// Spawn reader thread for subsequent events — emit to all windows that have this cwd active.
	let app = window.app_handle().clone();
	let reader_cwd = cwd.clone();
	std::thread::spawn(move || {
		log_file(&format!("reader thread: started for cwd={}", reader_cwd));
		for line in reader.lines() {
			match line {
				Ok(line) => {
					let trimmed = line.trim();
					if trimmed.is_empty() || !trimmed.starts_with('{') {
						continue;
					}
					let mut parsed: Value = match serde_json::from_str(trimmed) {
						Ok(v) => v,
						Err(_) => continue,
					};
					log_file(&format!("sidecar stdout [cwd={}]: {}", reader_cwd, trimmed));
					// Emit to all windows that have this cwd as active.
					let app_ref = &app;
					let active = app_ref.state::<BridgeState>();
					let active_map = lock_ok(&active.active);
					// Emit to ALL windows — include _cwd so frontend can filter.
					// This ensures events are received even when the workspace is not active.
					let etype = parsed
						.get("type")
						.and_then(|t| t.as_str())
						.unwrap_or("")
						.to_string();
					emit_to_pet_window(app_ref, &parsed, &reader_cwd);
					if etype == "response" {
						// Add _cwd to response for frontend routing.
						if let Some(obj) = parsed.as_object_mut() {
							obj.insert("_cwd".to_string(), Value::String(reader_cwd.clone()));
						}
					}
					for (label, _ac_cwd) in active_map.iter() {
						if let Some(win) = app_ref.get_webview_window(label) {
							match etype.as_str() {
								"response" => {
									let mut tagged = parsed.clone();
									if let Some(obj) = tagged.as_object_mut() {
										obj.insert(
											"_cwd".to_string(),
											Value::String(reader_cwd.clone()),
										);
									}
									let _ = win.emit("rpc_response", tagged);
								}
								"extension_ui_request" => {
									let _ = win.emit("extension_ui_request", parsed.clone());
								}
								_ => {
									let mut tagged = parsed.clone();
									if let Some(obj) = tagged.as_object_mut() {
										obj.insert(
											"_cwd".to_string(),
											Value::String(reader_cwd.clone()),
										);
									}
									let _ = win.emit("rpc_event", tagged);
								}
							}
						}
					}
				}
				Err(e) => {
					log_file(&format!("reader error [cwd={}]: {e}", reader_cwd));
					break;
				}
			}
		}
		log_file(&format!("reader thread: EOF for cwd={}", reader_cwd));
		// Reap the dead sidecar: remove from the map and wait() to avoid a
		// zombie process lingering until the GUI exits. drop(stdin) first so
		// the write pipe is closed before we wait for exit.
		// If kill_sidecar_for_cwd already removed it, we get None and skip.
		{
			let app_ref = &app;
			let state = app_ref.state::<BridgeState>();
			let mut sidecars = state.sidecars.lock().unwrap();
			if let Some(mut entry) = sidecars.remove(&reader_cwd) {
				let pid = entry.child.id();
				drop(entry.stdin);
				let _ = entry.child.wait();
				log_file(&format!(
					"reader thread: reaped sidecar pid={:?} cwd={}",
					pid, reader_cwd
				));
			}
		}
		// Notify all windows — sidecar_exit includes cwd for frontend filtering.
		// Suppress the event while restart_sidecar is in the middle of
		// reaping the old child, so the GUI's auto-restart loop doesn't
		// race it. (Even if the event leaks through, the GUI restart loop
		// checks BridgeState.restarting client-side via a separate
		// query, but suppressing server-side is cleaner.)
		let app_ref = &app;
		let state_ref = app_ref.state::<BridgeState>();
		let suppress = state_ref.restarting.lock().unwrap().contains(&reader_cwd);
		let active = state_ref;
		let active_map = lock_ok(&active.active);
		if !suppress {
			for (label, _ac_cwd) in active_map.iter() {
				if let Some(win) = app_ref.get_webview_window(label) {
					let _ = win.emit(
						"sidecar_exit",
						serde_json::json!({ "code": null, "cwd": reader_cwd }),
					);
				}
			}
		}
	});

	log_file("init_sidecar: done");
	Ok(state_data.to_string())
}

async fn connect_remote_gateway(
	window: &tauri::Window,
	state: &BridgeState,
	cwd: &str,
	window_label: &str,
	config: &remote::RemoteWorkspaceConfig,
	control_socket: &Path,
	install: &remote_deploy::RemoteServerInstall,
) -> Result<String, String> {
	let (local_socket, gateway_tunnel) =
		match remote_deploy::open_gateway_channel(config, control_socket, install) {
			Ok(value) => value,
			Err(error) => {
				stop_remote_runtime(state, cwd);
				return Err(error);
			}
		};
	{
		let mut runtimes = lock_ok(&state.remote_runtimes);
		if let Some(runtime) = runtimes.get_mut(cwd) {
			runtime.gateway_tunnel = Some(gateway_tunnel);
			runtime.gateway_local_socket = Some(local_socket.clone());
		}
	}
	let channel = match gateway_channel::GatewayChannel::connect(&local_socket) {
		Ok(channel) => channel,
		Err(error) => {
			stop_remote_runtime(state, cwd);
			return Err(format!("Connect to remote Pizza gateway: {error}"));
		}
	};
	if let Err(error) = channel.attach(&config.remote_path) {
		channel.close();
		stop_remote_runtime(state, cwd);
		return Err(format!("Attach remote workspace: {error}"));
	}
	let response = match gateway_rpc(
		&channel,
		&config.remote_path,
		serde_json::json!({
			"id": uuid::Uuid::new_v4().to_string(),
			"type": "get_state"
		}),
	)
	.await
	{
		Ok(response) => response,
		Err(error) => {
			channel.close();
			stop_remote_runtime(state, cwd);
			return Err(format!("Remote Pizza gateway startup failed: {error}"));
		}
	};
	if response.get("success").and_then(Value::as_bool) != Some(true) {
		channel.close();
		stop_remote_runtime(state, cwd);
		return Err(response
			.get("error")
			.and_then(Value::as_str)
			.unwrap_or("Remote Pizza returned an invalid startup response")
			.to_string());
	}

	let mut state_data = response;
	rewrite_remote_service_ports(state, cwd, &mut state_data);
	lock_ok(&state.channels).insert(cwd.to_string(), channel.clone());
	lock_ok(&state.active).insert(window_label.to_string(), cwd.to_string());
	emit_frame_to_windows(window.app_handle(), cwd, state_data.clone());

	let app = window.app_handle().clone();
	let drain_cwd = cwd.to_string();
	thread::spawn(move || loop {
		let messages = channel.drain_events();
		let disconnected = messages
			.iter()
			.any(|message| matches!(message, gateway_channel::ChannelMessage::Disconnected));
		for message in messages {
			if let gateway_channel::ChannelMessage::Event { frame, .. } = message {
				let state_ref = app.state::<BridgeState>();
				let mut frame = frame;
				rewrite_remote_service_ports(state_ref.inner(), &drain_cwd, &mut frame);
				emit_frame_to_windows(&app, &drain_cwd, frame);
			}
		}
		if disconnected {
			channel.close();
			let state_ref = app.state::<BridgeState>();
			lock_ok(&state_ref.channels).remove(&drain_cwd);
			clear_remote_tunnels(state_ref.inner(), &drain_cwd);
			let labels: Vec<String> = lock_ok(&state_ref.active).keys().cloned().collect();
			for label in labels {
				if let Some(win) = app.get_webview_window(&label) {
					let _ = win.emit(
						"sidecar_exit",
						serde_json::json!({ "code": null, "cwd": drain_cwd }),
					);
				}
			}
			break;
		}
		thread::sleep(Duration::from_millis(50));
	});

	Ok(state_data.to_string())
}

/// Install or reuse the versioned remote server, connect to its persistent
/// gateway over an SSH Unix-socket tunnel, and attach this workspace.
async fn init_remote_sidecar(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	window_label: String,
	cwd: String,
) -> Result<String, String> {
	let init_lock = {
		let mut locks = lock_ok(&state.remote_init_locks);
		locks
			.entry(window_label.clone())
			.or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
			.clone()
	};
	let _init_guard = init_lock.lock().await;

	#[cfg(not(unix))]
	{
		return init_remote_sidecar_legacy(window, state, window_label, cwd).await;
	}

	#[cfg(unix)]
	{
		let config = remote_workspace_config(state.inner(), &cwd)
			.ok_or_else(|| format!("Remote workspace is not registered: {cwd}"))?;
		log_file(&format!(
			"init_remote_sidecar: target={} path={}",
			config.ssh_target, config.remote_path
		));

		let existing_channel = {
			let mut channels = lock_ok(&state.channels);
			match channels.get(&cwd) {
				Some(channel) if !channel.is_alive() => {
					log_file(&format!(
						"init_remote_sidecar: dropping dead cached channel cwd={cwd}"
					));
					channels.remove(&cwd);
					None
				}
				other => other.cloned(),
			}
		};
		if let Some(channel) = existing_channel {
			let gateway_workspace = gateway_workspace_for_cwd(state.inner(), &cwd);
			let response = gateway_rpc(
				&channel,
				&gateway_workspace,
				serde_json::json!({
					"id": uuid::Uuid::new_v4().to_string(),
					"type": "get_state"
				}),
			)
			.await;
			match response {
				Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {
					lock_ok(&state.active).insert(window_label, cwd.clone());
					let mut response = response;
					rewrite_remote_service_ports(state.inner(), &cwd, &mut response);
					emit_frame_to_windows(window.app_handle(), &cwd, response.clone());
					return Ok(response.to_string());
				}
				Ok(response) => {
					let detail = response
						.get("error")
						.and_then(Value::as_str)
						.unwrap_or("cached remote gateway channel returned an error");
					log_file(&format!(
						"init_remote_sidecar: cached channel failed cwd={cwd}: {detail}"
					));
				}
				Err(error) => {
					log_file(&format!(
						"init_remote_sidecar: cached channel probe failed cwd={cwd}: {error}"
					));
				}
			}
			channel.close();
			stop_remote_runtime(state.inner(), &cwd);
		}

		let asset_dir = remote_server_asset_dir(&window.app_handle())?;
		let manifest = remote_deploy::remote_server_manifest(&asset_dir.join("manifest.json"))?;
		let version = manifest.version.clone();
		stop_remote_runtime(state.inner(), &cwd);
		let mut config = config;
		let control_socket = remote::environment_control_socket_path(&config);
		{
			let mut runtimes = lock_ok(&state.remote_runtimes);
			runtimes.insert(
				cwd.clone(),
				RemoteRuntime {
					control_socket: control_socket.clone(),
					tunnels: HashMap::new(),
					gateway_tunnel: None,
					gateway_local_socket: None,
				},
			);
		}
		let master_result = {
			let (config, control_socket) = (config.clone(), control_socket.clone());
			run_blocking(move || remote::ensure_control_master(&config, &control_socket)).await
		};
		if let Err(error) = master_result {
			log_file(&format!(
				"init_remote_sidecar: SSH control master unavailable cwd={cwd}: {error}"
			));
		}

		if config.pizza_command.is_some() {
			let probe = {
				let (config, control_socket, version) =
					(config.clone(), control_socket.clone(), version.clone());
				run_blocking(move || {
					remote_deploy::probe_managed_gateway(&config, &control_socket, &version)
				})
				.await
			};
			match probe {
				Ok(Some(gateway_socket)) => {
					log_file(&format!(
						"init_remote_sidecar: fast reconnect cwd={cwd} version={version}"
					));
					let fast_install = remote_deploy::RemoteServerInstall {
						version: version.clone(),
						pizza_command: config.pizza_command.clone().unwrap_or_default(),
						gateway_socket,
						service_mode: "reconnect".to_string(),
					};
					match connect_remote_gateway(
						&window,
						state.inner(),
						&cwd,
						&window_label,
						&config,
						&control_socket,
						&fast_install,
					)
					.await
					{
						Ok(response) => {
							schedule_remote_provider_provisioning(
								window.app_handle(),
								Duration::ZERO,
							);
							return Ok(response);
						}
						Err(error) => {
							log_file(&format!(
								"init_remote_sidecar: fast reconnect failed cwd={cwd}: {error}"
							));
						}
					}
				}
				Ok(None) => {}
				Err(error) => {
					log_file(&format!(
						"init_remote_sidecar: fast reconnect probe skipped cwd={cwd}: {error}"
					));
				}
			}
			stop_remote_runtime(state.inner(), &cwd);
			{
				let mut runtimes = lock_ok(&state.remote_runtimes);
				runtimes.insert(
					cwd.clone(),
					RemoteRuntime {
						control_socket: control_socket.clone(),
						tunnels: HashMap::new(),
						gateway_tunnel: None,
						gateway_local_socket: None,
					},
				);
			}
		}

		let install_lock = lock_ok(&state.remote_install_locks)
			.entry(control_socket.clone())
			.or_insert_with(|| Arc::new(Mutex::new(())))
			.clone();
		let install_result = {
			let (config, control_socket) = (config.clone(), control_socket.clone());
			run_blocking(move || {
				let _guard = lock_ok(&install_lock);
				remote_deploy::ensure_remote_server(&config, &control_socket, &asset_dir, &manifest)
			})
			.await
		};
		let install = match install_result {
			Ok(install) => install,
			Err(error) => {
				stop_remote_runtime(state.inner(), &cwd);
				return Err(format!("Remote Pizza server installation failed: {error}"));
			}
		};
		log_file(&format!(
			"init_remote_sidecar: server version={} service={} socket={}",
			install.version, install.service_mode, install.gateway_socket
		));
		if config.pizza_command.as_deref() != Some(install.pizza_command.as_str()) {
			config.pizza_command = Some(install.pizza_command.clone());
			let workspace_snapshot = {
				let mut workspaces = lock_ok(&state.remote_workspaces);
				if let Some(saved) = workspaces.get_mut(&cwd) {
					saved.pizza_command = Some(install.pizza_command.clone());
				}
				workspaces.clone()
			};
			if let Err(error) = remote::save_remote_workspaces(&workspace_snapshot) {
				log_file(&format!(
					"init_remote_sidecar: failed to persist managed Pizza command: {error}"
				));
			}
		}

		// Credential sync is opt-in per workspace and never blocks the
		// connection: the remote host may have its own provider setup.
		let provision = match agent_dir() {
			Ok(local_agent_dir) => {
				let (config, control_socket) = (config.clone(), control_socket.clone());
				run_blocking(move || {
					remote::provision_remote_provider_config(
						&config,
						&control_socket,
						&local_agent_dir,
					)
				})
				.await
			}
			Err(error) => Err(error),
		};
		log_provider_sync("init_remote_sidecar", &cwd, provision);

		let state_data = connect_remote_gateway(
			&window,
			state.inner(),
			&cwd,
			&window_label,
			&config,
			&control_socket,
			&install,
		)
		.await?;
		log_file("init_remote_sidecar: remote gateway attached");
		Ok(state_data)
	}
}

/// Legacy per-workspace SSH sidecar used on desktop platforms without Unix
/// socket forwarding. Unix/macOS uses the managed remote gateway path above.
#[allow(dead_code)]
async fn init_remote_sidecar_legacy(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	window_label: String,
	cwd: String,
) -> Result<String, String> {
	let config = remote_workspace_config(state.inner(), &cwd)
		.ok_or_else(|| format!("Remote workspace is not registered: {cwd}"))?;
	log_file(&format!(
		"init_remote_sidecar: target={} path={}",
		config.ssh_target, config.remote_path
	));

	let already_running = lock_ok(&state.sidecars).contains_key(&cwd);
	if already_running {
		lock_ok(&state.active).insert(window_label.clone(), cwd.clone());
		let id = uuid::Uuid::new_v4().to_string();
		let mut sidecars = lock_ok(&state.sidecars);
		let sidecar = sidecars
			.get_mut(&cwd)
			.ok_or_else(|| "Remote sidecar disappeared".to_string())?;
		write_rpc_line(
			sidecar,
			serde_json::json!({ "id": id, "type": "get_state" }),
		)?;
		log_file("init_remote_sidecar: switched to running remote sidecar");
		return Ok("{}".to_string());
	}

	let mut config = config;
	let (resolved_command, resolved_version) = remote::resolve_remote_pizza_command(&config)
		.map_err(|error| format!("Remote Pizza detection failed: {error}"))?;
	if config.pizza_command.as_deref() != Some(resolved_command.as_str()) {
		config.pizza_command = Some(resolved_command.clone());
		let workspace_snapshot = {
			let mut workspaces = lock_ok(&state.remote_workspaces);
			if let Some(saved) = workspaces.get_mut(&cwd) {
				saved.pizza_command = Some(resolved_command.clone());
			}
			workspaces.clone()
		};
		if let Err(error) = remote::save_remote_workspaces(&workspace_snapshot) {
			log_file(&format!(
				"init_remote_sidecar: failed to persist resolved Pizza command: {error}"
			));
		}
	}
	log_file(&format!(
		"init_remote_sidecar: resolved Pizza command={} version={}",
		resolved_command, resolved_version
	));

	let control_socket = remote::control_socket_path(&config.id);
	clear_remote_tunnels(state.inner(), &cwd);
	{
		let mut runtimes = lock_ok(&state.remote_runtimes);
		runtimes
			.entry(cwd.clone())
			.or_insert_with(|| RemoteRuntime {
				control_socket: control_socket.clone(),
				tunnels: HashMap::new(),
				gateway_tunnel: None,
				gateway_local_socket: None,
			});
	}

	// Sync before the remote RPC process starts so it sees the provider
	// snapshot; opt-in per workspace and never fatal.
	let provision = agent_dir().and_then(|local_agent_dir| {
		remote::provision_remote_provider_config(&config, &control_socket, &local_agent_dir)
	});
	log_provider_sync("init_remote_sidecar", &cwd, provision);

	let mut child = match remote::spawn_remote_agent(&config, &control_socket) {
		Ok(child) => child,
		Err(error) => {
			stop_remote_runtime(state.inner(), &cwd);
			return Err(error);
		}
	};
	let stdin = child.stdin.take().ok_or("no remote stdin")?;
	let stdout = child.stdout.take().ok_or("no remote stdout")?;
	let stderr = child.stderr.take().ok_or("no remote stderr")?;
	let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
	let stderr_buf_for_thread = Arc::clone(&stderr_buf);
	let stderr_thread = thread::spawn(move || {
		let mut reader = BufReader::new(stderr);
		let mut bytes = Vec::new();
		let _ = reader.read_to_end(&mut bytes);
		if let Ok(mut value) = stderr_buf_for_thread.lock() {
			value.push_str(&String::from_utf8_lossy(&bytes));
		}
	});

	let mut reader = BufReader::new(stdout);
	{
		let mut sidecars = lock_ok(&state.sidecars);
		sidecars.insert(cwd.clone(), SidecarEntry { child, stdin });
	}
	lock_ok(&state.active).insert(window_label, cwd.clone());
	{
		let mut sidecars = lock_ok(&state.sidecars);
		let sidecar = sidecars
			.get_mut(&cwd)
			.ok_or_else(|| "Remote sidecar disappeared during startup".to_string())?;
		if let Err(error) = write_rpc_line(
			sidecar,
			serde_json::json!({
				"id": uuid::Uuid::new_v4().to_string(),
				"type": "get_state"
			}),
		) {
			drop(sidecars);
			if let Some(mut entry) = lock_ok(&state.sidecars).remove(&cwd) {
				let _ = entry.child.kill();
				drop(entry.stdin);
				let _ = entry.child.wait();
			}
			stop_remote_runtime(state.inner(), &cwd);
			return Err(error);
		}
	}

	let mut first_line = String::new();
	let bytes_read = match reader.read_line(&mut first_line) {
		Ok(bytes_read) => bytes_read,
		Err(error) => {
			if let Some(mut entry) = lock_ok(&state.sidecars).remove(&cwd) {
				let _ = entry.child.kill();
				drop(entry.stdin);
				let _ = entry.child.wait();
			}
			stop_remote_runtime(state.inner(), &cwd);
			return Err(format!("read remote response: {error}"));
		}
	};
	if bytes_read == 0 {
		let mut sidecars = lock_ok(&state.sidecars);
		let mut entry = sidecars
			.remove(&cwd)
			.ok_or_else(|| "Remote sidecar exited during startup".to_string())?;
		drop(entry.stdin);
		let _ = entry.child.wait();
		drop(sidecars);
		let _ = stderr_thread.join();
		let detail = stderr_buf
			.lock()
			.map(|value| value.trim().to_string())
			.unwrap_or_default();
		stop_remote_runtime(state.inner(), &cwd);
		return Err(if detail.is_empty() {
			"Remote Pizza exited before responding".to_string()
		} else {
			format!("Remote Pizza exited before responding: {detail}")
		});
	}

	if !first_line.trim_start().starts_with('{') {
		if let Some(mut entry) = lock_ok(&state.sidecars).remove(&cwd) {
			let _ = entry.child.kill();
			drop(entry.stdin);
			let _ = entry.child.wait();
		}
		stop_remote_runtime(state.inner(), &cwd);
		return Err(format!(
			"Remote Pizza returned an invalid startup response: {}",
			first_line.trim()
		));
	}
	let mut state_data: Value = serde_json::from_str(first_line.trim()).unwrap_or(Value::Null);
	log_file(&format!(
		"init_remote_sidecar: first response={}",
		first_line.trim()
	));
	rewrite_remote_service_ports(state.inner(), &cwd, &mut state_data);

	let app = window.app_handle().clone();
	let reader_cwd = cwd.clone();
	thread::spawn(move || {
		log_file(&format!(
			"remote reader thread: started for cwd={}",
			reader_cwd
		));
		for line in reader.lines() {
			let Ok(line) = line else {
				break;
			};
			let trimmed = line.trim();
			if trimmed.is_empty() || !trimmed.starts_with('{') {
				continue;
			}
			let Ok(mut parsed) = serde_json::from_str::<Value>(trimmed) else {
				continue;
			};
			let state_ref = app.state::<BridgeState>();
			rewrite_remote_service_ports(state_ref.inner(), &reader_cwd, &mut parsed);
			log_file(&format!(
				"remote sidecar stdout [cwd={}]: {}",
				reader_cwd, trimmed
			));
			emit_frame_to_windows(&app, &reader_cwd, parsed);
		}
		log_file(&format!("remote reader thread: EOF for cwd={}", reader_cwd));
		{
			let state_ref = app.state::<BridgeState>();
			let mut sidecars = lock_ok(&state_ref.sidecars);
			if let Some(mut entry) = sidecars.remove(&reader_cwd) {
				let _ = entry.child.kill();
				drop(entry.stdin);
				let _ = entry.child.wait();
			}
			clear_remote_tunnels(state_ref.inner(), &reader_cwd);
			let labels: Vec<String> = lock_ok(&state_ref.active).keys().cloned().collect();
			for label in labels {
				if let Some(win) = app.get_webview_window(&label) {
					let _ = win.emit(
						"sidecar_exit",
						serde_json::json!({ "code": null, "cwd": reader_cwd }),
					);
				}
			}
		}
	});
	log_file("init_remote_sidecar: done");
	Ok(state_data.to_string())
}

/// Kill the sidecar for `cwd` (if any) and respawn it. Used after writing
/// a new provider API key so the freshly-written `auth.json` is picked up
/// — the facade caches its model registry on startup and won't rescan it
/// mid-session.
///
/// Marks `cwd` in the `restarting` set first so the GUI's auto-restart
/// path (which fires when it observes a `sidecar_exit` event) doesn't
/// race us by spawning its own replacement sidecar while we're still
/// reaping the old one. Without this guard `init_sidecar` ends up taking
/// the "already running" fast-path and silently does nothing.
#[tauri::command]
pub async fn restart_sidecar(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	cwd: String,
) -> Result<String, String> {
	log_file(&format!("restart_sidecar: start, cwd={}", cwd));
	// Claim the restart slot BEFORE killing so any sidecar_exit event
	// observed by the reader thread (which fires `kill_sidecar_for_cwd`
	// + emits the event) sees the flag and the GUI's auto-restart loop
	// no-ops.
	state.restarting.lock().unwrap().insert(cwd.clone());

	// Drop stdin + reap child so the OS releases the .lock in ~/.pizza/main
	// before we spawn the new sidecar.
	{
		let mut sidecars = state.sidecars.lock().unwrap();
		if let Some(mut entry) = sidecars.remove(&cwd) {
			let pid = entry.child.id();
			drop(entry.stdin);
			let _ = entry.child.kill();
			let _ = entry.child.wait();
			log_file(&format!(
				"restart_sidecar: reaped old sidecar pid={:?}",
				pid
			));
		}
	}
	if remote::is_remote_workspace_key(&cwd) {
		stop_remote_runtime(state.inner(), &cwd);
	}
	// Small grace period so the OS fully releases the process slot
	// (and, for the persistent Chat workspace, the .lock file gets
	// cleared by the dying process's exit handler).
	tokio::time::sleep(Duration::from_millis(150)).await;
	// `init_sidecar` takes `tauri::State` by value (per the tauri
	// command-macro convention). Clone our handle so we can release
	// the `restarting` flag after it returns.
	let state_for_cleanup = state.clone();
	let result = init_sidecar(window, state, Some(cwd.clone())).await;
	state_for_cleanup.restarting.lock().unwrap().remove(&cwd);
	result
}

#[tauri::command]
pub fn stop_sidecar(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
) -> Result<(), String> {
	kill_sidecar_for_window(state.inner(), window.label());
	Ok(())
}

#[tauri::command]
pub async fn rpc_command(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	command: Value,
	target_main: Option<bool>,
) -> Result<String, String> {
	let use_main = target_main.unwrap_or(false) || window.label() == PET_WINDOW_LABEL;
	if use_main {
		// Serialize lazy main startup across both pet chat surfaces.
		static MAIN_INIT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
		let _guard = MAIN_INIT.lock().await;
		let cwd = persistent_chat_cwd().ok_or("Cannot locate main assistant workspace")?;
		init_workspace(
			window.clone(),
			state.clone(),
			Some(cwd),
			"pet-chat".to_string(),
		)
		.await?;
	}
	let window_label = window.label();
	log_file(&format!("rpc_command [{}]: {}", window_label, command));
	let mut obj = command
		.as_object()
		.cloned()
		.ok_or("command must be an object")?;
	let id = if let Some(existing) = obj.get("id").and_then(|v| v.as_str()) {
		existing.to_string()
	} else {
		let id = uuid::Uuid::new_v4().to_string();
		obj.insert("id".to_string(), Value::String(id.clone()));
		id
	};
	let line = serde_json::to_string(&Value::Object(obj.clone())).map_err(|e| e.to_string())?;
	log_file(&format!("rpc_command [{}] sending: {}", window_label, line));

	// Pet chat uses its own routing entry for the persistent main workspace;
	// the main window may currently be displaying an unrelated project.
	let cwd = {
		let active = lock_ok(&state.active);
		let label = if use_main { "pet-chat" } else { window_label };
		active.get(label).cloned()
	};
	let cwd = cwd.ok_or("No active workspace for this window")?;

	// Gateway-mode: forward via the channel instead of the sidecar stdin.
	// channel.rpc() waits up to 320s for compaction, 60s otherwise.
	// gateway_rpc runs it on a blocking thread so we don't freeze the Tauri main thread / webview
	// event loop — the frontend needs the main thread free to receive the
	// rpc_response event we emit after the call returns.
	let mut channel_opt = {
		let mut channels = lock_ok(&state.channels);
		match channels.get(&cwd) {
			Some(channel) if !channel.is_alive() => {
				log_file(&format!(
					"rpc_command [{}] dropping dead gateway channel cwd={}",
					window_label, cwd
				));
				channels.remove(&cwd);
				None
			}
			other => other.cloned(),
		}
	};
	if channel_opt.is_none() && remote::is_remote_workspace_key(&cwd) {
		log_file(&format!(
			"rpc_command [{}] no remote gateway channel; reconnecting cwd={}",
			window_label, cwd
		));
		init_remote_sidecar(
			window.clone(),
			state.clone(),
			window_label.to_string(),
			cwd.clone(),
		)
		.await?;
		channel_opt = lock_ok(&state.channels).get(&cwd).cloned();
	}
	if let Some(channel) = channel_opt {
		let cmd_type_for_log = obj
			.get("type")
			.and_then(|t| t.as_str())
			.unwrap_or("")
			.to_string();
		let frame = Value::Object(obj);
		let gateway_workspace = gateway_workspace_for_cwd(state.inner(), &cwd);
		let mut resp = gateway_rpc(&channel, &gateway_workspace, frame)
			.await
			.map_err(|e| {
				log_file(&format!(
					"rpc_command [{}] gateway rpc FAILED: type={} error={}",
					window_label, cmd_type_for_log, e
				));
				e
			})?;
		if remote::is_remote_workspace_key(&cwd) {
			rewrite_remote_service_ports(state.inner(), &cwd, &mut resp);
		}
		log_file(&format!(
			"rpc_command [{}] gateway rpc OK: type={}",
			window_label, cmd_type_for_log
		));
		emit_frame_to_windows(window.app_handle(), &cwd, resp);
		return Ok(id);
	}

	// Sidecar mode: write to stdin (non-blocking, no await needed).
	{
		let mut sidecars = state.sidecars.lock().unwrap();
		let sidecar = sidecars.get_mut(&cwd).ok_or_else(|| {
			log_file(&format!(
				"rpc_command [{}] no sidecar or gateway channel cwd={}",
				window_label, cwd
			));
			"Sidecar is not running".to_string()
		})?;
		sidecar
			.stdin
			.write_all(line.as_bytes())
			.map_err(|e| format!("write: {e}"))?;
		sidecar
			.stdin
			.write_all(b"\n")
			.map_err(|e| format!("write nl: {e}"))?;
		sidecar.stdin.flush().map_err(|e| format!("flush: {e}"))?;
	}
	Ok(id)
}

/// Channel-management ops (list/save/delete/set_enabled/test) — gateway-level
/// requests that aren't tied to any one workspace. They reuse whatever live
/// gateway channel exists (the window's active one, else any), falling back to
/// a one-shot connection when nothing is attached yet (e.g. Plugins tab open
/// before any workspace).
#[tauri::command]
pub async fn channel_op(
	window: tauri::Window,
	app: AppHandle,
	state: tauri::State<'_, BridgeState>,
	request: Value,
) -> Result<Value, String> {
	let channel = {
		let cwd = lock_ok(&state.active).get(window.label()).cloned();
		let channels = lock_ok(&state.channels);
		cwd.and_then(|c| channels.get(&c).cloned())
			.or_else(|| channels.values().next().cloned())
	};
	if let Some(channel) = channel {
		let ch = channel.clone();
		return match tauri::async_runtime::spawn_blocking(move || ch.channel_op(request)).await {
			Ok(result) => result,
			Err(join_err) => Err(format!("blocking task failed: {join_err}")),
		};
	}
	// No channel connection exists yet: open a transient one for this op.
	let socket = gateway_channel::gateway_socket_path()
		.ok_or_else(|| "HOME not set; cannot resolve gateway socket".to_string())?;
	let (program, args) = gateway_command(resolve_pizza_command(&app));
	tauri::async_runtime::spawn_blocking(move || {
		gateway_channel::ensure_gateway(
			&socket,
			(&program, &args),
			Some(env!("CARGO_PKG_VERSION")),
		)?;
		let channel = gateway_channel::GatewayChannel::connect(&socket)?;
		let result = channel.channel_op(request);
		channel.close();
		result
	})
	.await
	.map_err(|e| format!("blocking task failed: {e}"))?
}

/// True when the desktop should route workspaces through the gateway broker
/// instead of spawning per-cwd sidecars. Gateway mode is the default — it
/// keeps agent processes alive across desktop restarts and lets multiple
/// clients (desktop, CLI, other agents) share one agent per workspace.
/// Set PIZZA_DESKTOP_GATEWAY=0 to fall back to the legacy per-cwd sidecar.
fn gateway_mode_enabled() -> bool {
	std::env::var("PIZZA_DESKTOP_GATEWAY")
		.map(|v| !(v == "0" || v.eq_ignore_ascii_case("false")))
		.unwrap_or(true)
}

/// Async-side ceiling for one gateway rpc. `GatewayChannel` bounds its own
/// I/O (command-specific response deadline that also covers the write), so
/// this only fires if the blocking task itself never completes — a backstop
/// guaranteeing the Tauri invoke always settles.
///
/// Run `channel.rpc` with ten seconds of watchdog headroom. If
/// the watchdog fires the connection is closed: its reader exits, pending
/// waiters are released and the drainer's disconnect path evicts it, so the
/// next init/retry builds a fresh connection instead of reusing a wedged one.
async fn gateway_rpc(
	channel: &gateway_channel::GatewayChannel,
	cwd: &str,
	frame: Value,
) -> Result<Value, String> {
	let ch = channel.clone();
	let cwd_owned = cwd.to_string();
	let watchdog = gateway_channel::rpc_timeout(&frame) + std::time::Duration::from_secs(10);
	match tokio::time::timeout(
		watchdog,
		tauri::async_runtime::spawn_blocking(move || ch.rpc(&cwd_owned, frame)),
	)
	.await
	{
		Ok(Ok(result)) => result,
		Ok(Err(join_err)) => Err(format!("blocking task failed: {join_err}")),
		Err(_elapsed) => {
			channel.close();
			Err(format!(
				"gateway rpc timed out after {}s; the connection was reset",
				watchdog.as_secs()
			))
		}
	}
}

/// Lock a BridgeState mutex, recovering from poisoning instead of panicking.
/// A panic elsewhere while holding the lock must not wedge every subsequent
/// command: a poisoned `Mutex` unwraps to a panic inside the async command,
/// which leaves the frontend invoke unsettled forever (observed on Windows as
/// an eternal "starting…" splash). The protected data are simple maps whose
/// invariants do not depend on lock handoff, so the poisoned data is still
/// usable.
fn lock_ok<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
	match m.lock() {
		Ok(guard) => guard,
		Err(poisoned) => poisoned.into_inner(),
	}
}

/// Emit one parsed Layer-0 frame to every window, tagged with `_cwd`, mirroring
/// the sidecar reader's contract: response→rpc_response, extension_ui_request
/// as-is, everything else→rpc_event.
fn emit_frame_to_windows(app: &AppHandle, cwd: &str, mut parsed: Value) {
	let etype = parsed
		.get("type")
		.and_then(|t| t.as_str())
		.unwrap_or("")
		.to_string();
	let state = app.state::<BridgeState>();
	if etype == "response" {
		complete_remote_reload_waiter(state.inner(), &parsed);
		maybe_schedule_model_config_sync(app, cwd, &parsed);
		if let Some(obj) = parsed.as_object_mut() {
			obj.insert("_cwd".to_string(), Value::String(cwd.to_string()));
		}
	}
	emit_to_pet_window(app, &parsed, cwd);
	// Snapshot the window labels and drop the lock BEFORE any webview emit:
	// `win.emit` is synchronous cross-process IPC — holding `active` across it
	// serializes every other command that needs the map and can deadlock with
	// a busy webview (observed on Windows as an eternal "starting…" splash).
	// The pet window is intentionally NOT included — the frames it needs
	// (responses, pet_state) reach it through emit_to_pet_window above.
	let labels: Vec<String> = lock_ok(&state.active).keys().cloned().collect();
	for label in &labels {
		if let Some(win) = app.get_webview_window(label) {
			match etype.as_str() {
				"response" => {
					let mut tagged = parsed.clone();
					if let Some(obj) = tagged.as_object_mut() {
						obj.insert("_cwd".to_string(), Value::String(cwd.to_string()));
					}
					let _ = win.emit("rpc_response", tagged);
				}
				"extension_ui_request" => {
					let _ = win.emit("extension_ui_request", parsed.clone());
				}
				_ => {
					let mut tagged = parsed.clone();
					if let Some(obj) = tagged.as_object_mut() {
						obj.insert("_cwd".to_string(), Value::String(cwd.to_string()));
					}
					let _ = win.emit("rpc_event", tagged);
				}
			}
		}
	}
}

/// Gateway-mode init: ensure the gateway is up, open one channel per workspace,
/// attach, fetch initial state, store the channel, and spawn a drainer that fans
/// the agent's events out to windows. Returns get_state JSON (same shape as
/// init_sidecar's first-line response).
async fn init_sidecar_via_gateway(
	app: AppHandle,
	state: tauri::State<'_, BridgeState>,
	window_label: String,
	cwd: String,
) -> Result<String, String> {
	log_file(&format!("init_sidecar_via_gateway: cwd={}", cwd));
	// Already attached? Just switch the active pointer and re-fetch state.
	// Extract the channel first, then drop all locks before awaiting.
	// A dead connection (closed by a failed write / watchdog) is dropped here
	// so we reconnect below rather than failing every command on it.
	let existing_channel = {
		let mut channels = lock_ok(&state.channels);
		match channels.get(&cwd) {
			Some(ch) if !ch.is_alive() => {
				log_file(&format!(
					"init_sidecar_via_gateway: dropping dead channel cwd={}",
					cwd
				));
				channels.remove(&cwd);
				None
			}
			other => other.cloned(),
		}
	};
	if let Some(ch) = existing_channel {
		lock_ok(&state.active).insert(window_label, cwd.clone());
		// Re-attach: the gateway may have idle-evicted the agent and cleared
		// subscribers[cwd] during teardown. Without re-attaching, event fan-out
		// silently drops because our subscriber is gone. attach is idempotent
		// (gateway re-adds our write fn to the subscriber set).
		let cwd_for_attach = cwd.clone();
		let ch_for_attach = ch.clone();
		let _ = tauri::async_runtime::spawn_blocking(move || ch_for_attach.attach(&cwd_for_attach))
			.await;
		let frame =
			serde_json::json!({ "id": uuid::Uuid::new_v4().to_string(), "type": "get_state" });
		let resp_result = gateway_rpc(&ch, &cwd, frame).await;
		// Return the actual state JSON so callers (especially restart_sidecar)
		// get a real payload instead of {}. In gateway mode restart_sidecar
		// can't respawn the agent process, so this re-fetched state — which
		// reflects any reload_providers-driven model changes — is the only
		// way the frontend learns that a model is now configured.
		let state_json = match resp_result {
			Ok(resp) => {
				emit_frame_to_windows(&app, &cwd, resp.clone());
				resp.to_string()
			}
			Err(e) => {
				log_file(&format!(
					"init_sidecar_via_gateway: re-attach get_state failed: {}",
					e
				));
				serde_json::json!({}).to_string()
			}
		};
		return Ok(state_json);
	}

	let socket = gateway_channel::gateway_socket_path()
		.ok_or_else(|| "HOME not set; cannot resolve gateway socket".to_string())?;
	let (program, args) = gateway_command(resolve_pizza_command(&app));
	let cwd_for_blocking = cwd.clone();
	// ensure_gateway, connect and attach all block (attach waits up to 15s
	// for attach_ok): keep them off the async runtime's worker threads.
	let (channel, resolved_cwd) = tauri::async_runtime::spawn_blocking(move || {
		gateway_channel::ensure_gateway(
			&socket,
			(&program, &args),
			Some(env!("CARGO_PKG_VERSION")),
		)?;
		let channel = gateway_channel::GatewayChannel::connect(&socket)?;
		match channel.attach(&cwd_for_blocking) {
			Ok(resolved) => Ok((channel, resolved)),
			Err(e) => {
				channel.close();
				Err(e)
			}
		}
	})
	.await
	.map_err(|e| format!("blocking task failed: {e}"))
	.and_then(|r| r)
	.map_err(|e| {
		log_file(&format!(
			"init_sidecar_via_gateway: connect/attach failed cwd={}: {}",
			cwd, e
		));
		e
	})?;
	log_file(&format!(
		"init_sidecar_via_gateway: attached resolved={}",
		resolved_cwd
	));

	// Initial state via the channel, emitted as rpc_response for the frontend.
	// On failure the unregistered channel is closed so it doesn't linger as
	// a zombie subscriber on the gateway; a retry builds a fresh connection.
	let state_frame =
		serde_json::json!({ "id": uuid::Uuid::new_v4().to_string(), "type": "get_state" });
	log_file(&format!(
		"init_sidecar_via_gateway: sending get_state cwd={}",
		cwd
	));
	let state_resp = gateway_rpc(&channel, &cwd, state_frame)
		.await
		.map_err(|e| {
			log_file(&format!(
				"init_sidecar_via_gateway: get_state failed cwd={}: {}",
				cwd, e
			));
			channel.close();
			format!("{e}. Click retry, or set PIZZA_DESKTOP_GATEWAY=0 to use direct sidecar mode.")
		})?;
	log_file("init_sidecar_via_gateway: get_state ok, registering channel");
	emit_frame_to_windows(&app, &resolved_cwd, state_resp);

	lock_ok(&state.channels).insert(cwd.clone(), channel.clone());
	lock_ok(&state.active).insert(window_label, cwd.clone());

	// Drain fanned-out events → windows. Exits when the channel disconnects.
	let app_for_drain = app.clone();
	let drain_cwd = resolved_cwd.clone();
	let channel_key = cwd.clone();
	std::thread::spawn(move || {
		loop {
			let messages = channel.drain_events();
			let disconnected = messages
				.iter()
				.any(|m| matches!(m, gateway_channel::ChannelMessage::Disconnected));
			for msg in messages {
				if let gateway_channel::ChannelMessage::Event { frame, .. } = msg {
					emit_frame_to_windows(&app_for_drain, &drain_cwd, frame);
				}
			}
			if disconnected {
				log_file(&format!("gateway channel disconnected cwd={}", drain_cwd));
				// Drop the stale channel so a fresh attach can take its place.
				// It's keyed by the requested cwd (not the resolved one), and
				// a re-init may already have replaced it with a live channel.
				{
					let state = app_for_drain.state::<BridgeState>();
					let mut channels = lock_ok(&state.channels);
					if channels.get(&channel_key).is_some_and(|c| !c.is_alive()) {
						channels.remove(&channel_key);
					}
				}
				// Notify the frontend exactly like a sidecar exit would, so its
				// reconnect/restart logic kicks in (it listens on "sidecar_exit").
				let active = lock_ok(&app_for_drain.state::<BridgeState>().active).clone();
				for (label, _ac_cwd) in active.iter() {
					if let Some(win) = app_for_drain.get_webview_window(label) {
						let _ = win.emit(
							"sidecar_exit",
							serde_json::json!({ "code": null, "cwd": drain_cwd }),
						);
					}
				}
				break;
			}
			std::thread::sleep(std::time::Duration::from_millis(50));
		}
	});

	Ok(serde_json::json!({}).to_string())
}

/// Window label for the detached floating pet webview.
pub const PET_WINDOW_LABEL: &str = "pet";

/// Forward responses and the core `pet_state` frames to the floating pet
/// window, if open. The last `pet_state` is cached in BridgeState so a freshly
/// (re)opened pet window can be repainted immediately. Remote workspaces own
/// a different machine's save, so their pet frames never reach this window.
/// `cwd` is empty when replaying an already tagged frame.
fn emit_to_pet_window(app: &AppHandle, frame: &Value, cwd: &str) {
	match frame.get("type").and_then(|t| t.as_str()) {
		Some("response") => {
			if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
				let _ = win.emit("rpc_response", frame);
			}
		}
		Some("pet_state") if !cwd.starts_with("remote://") => {
			let mut frame = frame.clone();
			if !cwd.is_empty() {
				if let Some(obj) = frame.as_object_mut() {
					obj.insert("_cwd".to_string(), Value::String(cwd.to_string()));
				}
			}
			// Identity belongs to the shared save, never to a stale sidecar.
			let save = get_pet_state().unwrap_or(Value::Null);
			if frame.get("pet").map(Value::is_null).unwrap_or(true) {
				if save.is_null() {
					close_pet_window_keep_flag(app);
				}
				return;
			}
			if frame.pointer("/pet/speciesId").and_then(Value::as_str)
				!= save.get("speciesId").and_then(Value::as_str)
			{
				return;
			}
			if let Some(state) = app.try_state::<BridgeState>() {
				if let Ok(mut slot) = state.pet_state_frame.lock() {
					*slot = Some(frame.clone());
				}
			}
			// Window ownership changes only through explicit actions/startup
			// restore: a delayed frame must never reopen a pet the user docked.
			if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
				let _ = win.emit("pet_state", frame.clone());
			}
		}
		_ => {}
	}
}

/// Create a new workspace window with its own independent sidecar.
#[tauri::command]
pub async fn new_workspace(app: AppHandle) -> Result<String, String> {
	let label = format!("workspace-{}", uuid::Uuid::new_v4().simple());
	log_file(&format!("new_workspace: creating window={}", label));
	let _window = {
		let builder = tauri::WebviewWindowBuilder::new(
			&app,
			&label,
			tauri::WebviewUrl::App("index.html".into()),
		)
		.title("Pizza")
		.inner_size(1200.0, 800.0)
		.min_inner_size(720.0, 480.0)
		.background_color(tauri::webview::Color(18, 18, 18, 255));
		#[cfg(target_os = "macos")]
		let builder = builder
			.title_bar_style(tauri::TitleBarStyle::Transparent)
			.hidden_title(true);
		builder
			.build()
			.map_err(|e| format!("Failed to create window: {e}"))?
	};
	Ok(label)
}

/// Serialize open/close of the pet window: maybe_reopen_pet_window and the
/// auto-open path in emit_to_pet_window can race the first frame — without a
/// guard both can observe "no window" and double-toggle.
static PET_WINDOW_TOGGLE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Toggle/detach share one idempotent creation path, so only one pet can exist.
#[tauri::command]
pub async fn toggle_pet_window(app: AppHandle) -> Result<String, String> {
	let _guard = lock_ok(&PET_WINDOW_TOGGLE);
	if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
		win.close().map_err(|e| e.to_string())?;
		set_pet_floating_flag(false);
		notify_pet_window_state(&app, false);
		return Ok("closed".into());
	}
	open_pet_window(&app, None)?;
	Ok("open".into())
}

fn open_pet_window(app: &AppHandle, point: Option<(f64, f64)>) -> Result<(), String> {
	if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
		if let Some((x, y)) = point {
			position_pet_at(&win, x, y)?;
		}
		return Ok(());
	}
	let builder = tauri::WebviewWindowBuilder::new(
		app,
		PET_WINDOW_LABEL,
		tauri::WebviewUrl::App("pet.html".into()),
	)
	.title("Pizza Pet")
	.inner_size(300.0, 300.0)
	.max_inner_size(300.0, 300.0)
	.resizable(false)
	.maximizable(false)
	.minimizable(false)
	.decorations(false)
	.always_on_top(true)
	.skip_taskbar(true)
	.shadow(false)
	.visible(false)
	.focused(false)
	.background_color(tauri::webview::Color(0, 0, 0, 0));
	#[cfg(target_os = "macos")]
	// The pet never takes focus, so let the first click (and right-click for
	// its menu) through instead of only activating the window.
	let builder = builder
		.transparent(true)
		.visible_on_all_workspaces(true)
		.accept_first_mouse(true);
	let win = builder.build().map_err(|e| format!("create pet: {e}"))?;
	if let Some((x, y)) = point {
		position_pet_at(&win, x, y)?;
	} else if let Ok(Some(monitor)) = win.primary_monitor() {
		let scale = monitor.scale_factor();
		let x = (monitor.position().x as f64 + monitor.size().width as f64) / scale - 180.0;
		let y = (monitor.position().y as f64 + monitor.size().height as f64) / scale - 180.0;
		position_pet_at(&win, x, y)?;
	}
	set_pet_floating_flag(true);
	Ok(())
}

fn position_pet_at(win: &tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
	if !x.is_finite() || !y.is_finite() {
		return Err("Invalid pet position".into());
	}
	// The compact pet's centre is fixed even when its chat controls expand.
	win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
		x - 150.0,
		y - 56.0,
	)))
	.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn detach_pet_window(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
	let _guard = lock_ok(&PET_WINDOW_TOGGLE);
	open_pet_window(&app, Some((x, y)))
}

#[tauri::command]
pub fn move_pet_window(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
	if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
		position_pet_at(&win, x, y)?;
	}
	Ok(())
}

/// Hand off visibility after the detached UI has mounted, avoiding duplicates.
#[tauri::command]
pub fn pet_window_ready(app: AppHandle) -> Result<(), String> {
	if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
		win.show().map_err(|e| e.to_string())?;
		notify_pet_window_state(&app, true);
		if let Some(state) = app.try_state::<BridgeState>() {
			let frame = state.pet_state_frame.lock().ok().and_then(|s| s.clone());
			if let Some(frame) = frame {
				emit_to_pet_window(&app, &frame, "");
			}
		}
	}
	Ok(())
}

#[tauri::command]
pub fn get_pet_window_state(app: AppHandle) -> bool {
	app.get_webview_window(PET_WINDOW_LABEL)
		.map(|w| w.is_visible().unwrap_or(false))
		.unwrap_or(false)
}

#[tauri::command]
pub async fn dock_pet_window(app: AppHandle) -> Result<(), String> {
	close_pet_window(app.clone()).await?;
	if let Some(main) = app.get_webview_window("main") {
		main.show().map_err(|e| e.to_string())?;
		let _ = main.unminimize();
		let _ = main.set_focus();
		let _ = main.emit("open_main_agent", ());
	}
	Ok(())
}

/// Persist the floating flag into ~/.pizza/agent/pet.json so the window
/// comes back on the next app start.
fn set_pet_floating_flag(floating: bool) {
	let Ok(dir) = agent_dir() else { return };
	let path = dir.join("pet.json");
	// Use the same directory lock as proper-lockfile in workspace processes.
	let lock = dir.join("pet.json.lock");
	let mut acquired = false;
	for _ in 0..10 {
		if std::fs::create_dir(&lock).is_ok() {
			acquired = true;
			break;
		}
		// Same rule as proper-lockfile's default `stale`: a holder that crashed
		// leaves a lock nobody refreshes; reclaim it after 10s.
		let stale = std::fs::metadata(&lock)
			.and_then(|m| m.modified())
			.ok()
			.and_then(|t| t.elapsed().ok())
			.is_some_and(|age| age > std::time::Duration::from_secs(10));
		if stale {
			let _ = std::fs::remove_dir(&lock);
			continue;
		}
		std::thread::sleep(std::time::Duration::from_millis(10));
	}
	if !acquired {
		log_file("pet floating preference: save is busy");
		return;
	}
	let temp = dir.join(format!("pet.{}.tmp", uuid::Uuid::new_v4()));
	let _ = (|| -> Result<(), Box<dyn std::error::Error>> {
		let mut save: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
		if let Some(obj) = save.as_object_mut() {
			obj.insert("floating".into(), Value::Bool(floating));
			std::fs::write(&temp, serde_json::to_string_pretty(&save)?)?;
			if let Ok(metadata) = std::fs::metadata(&path) {
				let _ = std::fs::set_permissions(&temp, metadata.permissions());
			}
			std::fs::rename(&temp, &path)?;
		}
		Ok(())
	})();
	let _ = std::fs::remove_file(temp);
	let _ = std::fs::remove_dir(lock);
}

/// Reopen the floating pet window on startup if a pet save exists and it was
/// floating when the app last closed (persisted as `floating: true` in
/// ~/.pizza/agent/pet.json).
pub fn maybe_reopen_pet_window(app: &AppHandle) {
	let Ok(dir) = agent_dir() else { return };
	let path = dir.join("pet.json");
	let Ok(raw) = std::fs::read_to_string(&path) else {
		return;
	};
	let Ok(save) = serde_json::from_str::<Value>(&raw) else {
		return;
	};
	// Hidden by default — reopen only if the user left it floating.
	if save.get("floating").and_then(|v| v.as_bool()) != Some(true) {
		return;
	}
	let app = app.clone();
	log_file("maybe_reopen_pet_window: floating pet found, reopening window");
	// Defer until the event loop is running.
	tauri::async_runtime::spawn(async move {
		let _guard = lock_ok(&PET_WINDOW_TOGGLE);
		let _ = open_pet_window(&app, None);
	});
}

/// Close the floating pet window without touching the persisted floating
/// flag. Called when the pet save is released or reset mid-session.
pub fn close_pet_window_keep_flag(app: &AppHandle) {
	if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
		log_file("close_pet_window_keep_flag: closing");
		let _ = win.close();
	}
	notify_pet_window_state(app, false);
}

/// Bring the main window forward and route it to the Pet settings page.
#[tauri::command]
pub fn open_pet_settings(app: AppHandle) -> Result<(), String> {
	let main = app
		.get_webview_window("main")
		.ok_or_else(|| "Main window is unavailable".to_string())?;
	main.show().map_err(|e| format!("show main window: {e}"))?;
	let _ = main.unminimize();
	main.set_focus()
		.map_err(|e| format!("focus main window: {e}"))?;
	main.emit("open_pet_settings", ())
		.map_err(|e| format!("navigate to Pet settings: {e}"))
}

/// Close the floating pet window (from its context menu).
#[tauri::command]
pub async fn close_pet_window(app: AppHandle) -> Result<(), String> {
	log_file("close_pet_window command called");
	if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
		win.close().map_err(|e| format!("close pet window: {e}"))?;
	}
	notify_pet_window_state(&app, false);
	set_pet_floating_flag(false);
	Ok(())
}

/// Read ~/.pizza/agent/pet.json so the floating pet window can render the
/// real pet (species/name/level) before any widget frame arrives — e.g.
/// when no workspace session has pushed a frame yet this run.
#[tauri::command]
pub fn get_pet_state() -> Result<Value, String> {
	let path = agent_dir()?.join("pet.json");
	match std::fs::read_to_string(&path) {
		Ok(raw) => serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()),
		Err(_) => Ok(Value::Null),
	}
}

/// Tell every window whether the floating pet window is open, so the
/// in-app widget card can hide/show accordingly.
fn notify_pet_window_state(app: &AppHandle, open: bool) {
	for label in app.webview_windows().keys() {
		if let Some(win) = app.get_webview_window(label) {
			let _ = win.emit("pet_window_state", serde_json::json!({ "open": open }));
		}
	}
}

/// List all workspaces from ~/.pizza/agent/workspaces/*/meta.json
#[tauri::command]
pub async fn list_workspaces(state: tauri::State<'_, BridgeState>) -> Result<Vec<Value>, String> {
	let workspaces_dir = workspace_meta_root().ok_or("could not determine home directory")?;

	let mut workspaces: Vec<Value> = Vec::new();

	if workspaces_dir.exists() {
		let entries = std::fs::read_dir(&workspaces_dir).map_err(|e| format!("read_dir: {e}"))?;
		for entry in entries {
			let entry = entry.map_err(|e| format!("entry: {e}"))?;
			let meta_path = entry.path().join("meta.json");
			if !meta_path.exists() {
				continue;
			}
			let raw = match std::fs::read_to_string(&meta_path) {
				Ok(s) => s,
				Err(_) => continue,
			};
			let mut meta: Value = match serde_json::from_str(&raw) {
				Ok(v) => v,
				Err(_) => continue,
			};
			// Annotate whether the project directory still exists. Entries whose
			// directory was removed externally (deleted repo, cleaned /tmp, …)
			// must not be switchable — the UI offers "remove stale entry"
			// instead, so clicking the row never reaches init_sidecar's
			// "Directory does not exist" error.
			let dir_exists = meta
				.get("cwd")
				.and_then(|v| v.as_str())
				.map(|cwd| std::path::Path::new(cwd).is_dir())
				.unwrap_or(false);
			if let Some(obj) = meta.as_object_mut() {
				obj.insert("dir_exists".to_string(), Value::Bool(dir_exists));
				obj.insert("kind".to_string(), Value::String("local".to_string()));
			}
			workspaces.push(meta);
		}
	}

	for config in lock_ok(&state.remote_workspaces).values() {
		workspaces.push(remote::remote_workspace_meta(config));
	}

	// Sort by last_accessed_at descending
	workspaces.sort_by(|a, b| {
		let a_time = a
			.get("last_accessed_at")
			.and_then(|v| v.as_i64())
			.unwrap_or(0);
		let b_time = b
			.get("last_accessed_at")
			.and_then(|v| v.as_i64())
			.unwrap_or(0);
		b_time.cmp(&a_time)
	});

	Ok(workspaces)
}

/// Delete a workspace by its workspace_id — removes the workspace meta directory
/// and kills any running sidecar for that workspace's cwd.
#[tauri::command]
pub async fn delete_workspace(
	state: tauri::State<'_, BridgeState>,
	workspace_id: String,
) -> Result<(), String> {
	if let Some(remote_id) = workspace_id.strip_prefix("remote_") {
		let cwd = remote::workspace_key(remote_id);
		kill_sidecar_for_cwd(state.inner(), &cwd);
		let mut workspaces = lock_ok(&state.remote_workspaces);
		let removed = workspaces.remove(&cwd);
		if let Err(error) = remote::save_remote_workspaces(&workspaces) {
			if let Some(config) = removed {
				workspaces.insert(cwd, config);
			}
			return Err(error);
		}
		if let Some(config) = removed {
			remote::forget_remote_workspace_secret(&config);
		}
		return Ok(());
	}

	let ws_dir = workspace_meta_root()
		.ok_or("could not determine home directory")?
		.join(&workspace_id);

	if !ws_dir.exists() {
		return Err(format!("Workspace {} not found", workspace_id));
	}

	// Read the cwd from meta.json before deleting, so we can kill the sidecar.
	let meta_path = ws_dir.join("meta.json");
	let cwd: Option<String> = if meta_path.exists() {
		if let Ok(raw) = std::fs::read_to_string(&meta_path) {
			if let Ok(meta) = serde_json::from_str::<Value>(&raw) {
				meta.get("cwd")
					.and_then(|v| v.as_str())
					.map(|s| s.to_string())
			} else {
				None
			}
		} else {
			None
		}
	} else {
		None
	};

	// Kill sidecar if running.
	if let Some(ref cwd) = cwd {
		kill_sidecar_for_cwd(state.inner(), cwd);
	}

	// Remove the workspace directory.
	std::fs::remove_dir_all(&ws_dir).map_err(|e| format!("Failed to delete workspace: {e}"))?;

	log_file(&format!("delete_workspace: deleted {}", workspace_id));
	Ok(())
}

/// Reveal an arbitrary file in the system file manager (Finder on macOS,
/// Explorer on Windows, the desktop file manager on Linux). The path should
/// be absolute — the sidecar places uploads under <cwd>/.pizza/uploads/...
/// and the frontend surfaces them as <file path="..."/> references.
#[tauri::command]
pub async fn reveal_file(absolute_path: String) -> Result<(), String> {
	let path = expand_tilde(&absolute_path);

	if !std::path::Path::new(&path).exists() {
		return Err(format!("Path does not exist: {}", path));
	}

	#[cfg(target_os = "macos")]
	let opener = "open";
	#[cfg(target_os = "linux")]
	let opener = "xdg-open";
	#[cfg(target_os = "windows")]
	let opener = "explorer";

	std::process::Command::new(opener)
		.arg(&path)
		.spawn()
		.map_err(|e| format!("Failed to open file manager: {e}"))?;

	Ok(())
}

fn file_name_for_path(path: &std::path::Path) -> String {
	path.file_name()
		.and_then(|name| name.to_str())
		.filter(|name| !name.is_empty())
		.unwrap_or("untitled")
		.to_string()
}

fn sanitize_upload_filename(filename: &str) -> String {
	let cleaned: String = filename
		.chars()
		.map(|c| {
			if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
				c
			} else {
				'_'
			}
		})
		.collect();
	let trimmed = cleaned.trim().trim_matches('.').to_string();
	if trimmed.is_empty() {
		"untitled".to_string()
	} else {
		trimmed
	}
}

fn guess_mime_type(path: &std::path::Path, fallback: &str) -> String {
	if !fallback.is_empty() && fallback != "application/octet-stream" {
		return fallback.to_string();
	}
	let ext = path
		.extension()
		.and_then(|ext| ext.to_str())
		.unwrap_or("")
		.to_ascii_lowercase();
	match ext.as_str() {
		"jpg" | "jpeg" => "image/jpeg",
		"png" => "image/png",
		"gif" => "image/gif",
		"webp" => "image/webp",
		"svg" => "image/svg+xml",
		"pdf" => "application/pdf",
		"txt" | "log" => "text/plain",
		"md" | "markdown" => "text/markdown",
		"json" => "application/json",
		"csv" => "text/csv",
		"html" | "htm" => "text/html",
		"css" => "text/css",
		"js" | "mjs" | "cjs" => "text/javascript",
		"ts" | "tsx" => "text/typescript",
		"py" => "text/x-python",
		"rs" => "text/rust",
		"doc" => "application/msword",
		"docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"xls" => "application/vnd.ms-excel",
		"xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"ppt" => "application/vnd.ms-powerpoint",
		"pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"zip" => "application/zip",
		_ => fallback,
	}
	.to_string()
}

#[tauri::command]
pub async fn describe_dropped_files(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	paths: Vec<String>,
) -> Result<Vec<FileAttachmentInfo>, String> {
	let active_cwd = lock_ok(&state.active).get(window.label()).cloned();
	if let Some(cwd) = active_cwd.filter(|cwd| remote::is_remote_workspace_key(cwd)) {
		let mut files = Vec::new();
		for raw_path in paths {
			let path = PathBuf::from(&raw_path);
			let metadata = std::fs::metadata(&path)
				.map_err(|e| format!("Failed to read dropped path {}: {e}", path.display()))?;
			if metadata.is_dir() {
				return Err("Remote directory attachments are not supported".to_string());
			}
			let bytes = std::fs::read(&path)
				.map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
			let fallback = guess_mime_type(&path, "application/octet-stream");
			files.push(save_remote_upload(
				state.inner(),
				&cwd,
				&file_name_for_path(&path),
				&fallback,
				&bytes,
			)?);
		}
		return Ok(files);
	}

	let mut files = Vec::new();
	for raw_path in paths {
		let path = PathBuf::from(&raw_path);
		let absolute = path.canonicalize().unwrap_or(path);
		let metadata = std::fs::metadata(&absolute)
			.map_err(|e| format!("Failed to read dropped path {}: {e}", absolute.display()))?;
		let fallback = if metadata.is_dir() {
			"application/x-directory"
		} else {
			"application/octet-stream"
		};
		files.push(FileAttachmentInfo {
			kind: "file",
			absolute_path: absolute.to_string_lossy().to_string(),
			relative_path: absolute.to_string_lossy().to_string(),
			mime_type: guess_mime_type(&absolute, fallback),
			name: file_name_for_path(&absolute),
			size: metadata.len(),
		});
	}
	Ok(files)
}

#[tauri::command]
pub async fn save_upload(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	filename: String,
	mime_type: String,
	data_b64: String,
) -> Result<FileAttachmentInfo, String> {
	let window_label = window.label().to_string();
	let cwd = {
		let active = lock_ok(&state.active);
		active
			.get(&window_label)
			.cloned()
			.ok_or("No active workspace for this window")?
	};
	let safe_name = sanitize_upload_filename(&filename);
	let bytes = base64::engine::general_purpose::STANDARD
		.decode(data_b64)
		.map_err(|e| format!("Invalid upload data: {e}"))?;
	if remote::is_remote_workspace_key(&cwd) {
		return save_remote_upload(state.inner(), &cwd, &filename, &mime_type, &bytes);
	}
	let upload_dir = PathBuf::from(&cwd).join(".pizza").join("uploads");
	std::fs::create_dir_all(&upload_dir)
		.map_err(|e| format!("Failed to create upload directory: {e}"))?;
	let stored_name = format!("{}-{}", uuid::Uuid::new_v4(), safe_name);
	let path = upload_dir.join(stored_name);
	std::fs::write(&path, &bytes).map_err(|e| format!("Failed to save upload: {e}"))?;
	let relative_path = path
		.strip_prefix(&cwd)
		.map(|p| p.to_string_lossy().to_string())
		.unwrap_or_else(|_| path.to_string_lossy().to_string());
	Ok(FileAttachmentInfo {
		kind: "file",
		absolute_path: path.to_string_lossy().to_string(),
		relative_path,
		mime_type: guess_mime_type(&path, &mime_type),
		name: filename,
		size: bytes.len() as u64,
	})
}

/// Reveal a workspace's cwd in the system file manager (Finder on macOS).
#[tauri::command]
pub async fn reveal_workspace(cwd: String) -> Result<(), String> {
	if remote::is_remote_workspace_key(&cwd) {
		return Err("Remote workspaces cannot be opened in the local file manager".to_string());
	}
	let path = expand_tilde(&cwd);

	if !std::path::Path::new(&path).exists() {
		return Err(format!("Path does not exist: {}", path));
	}

	#[cfg(target_os = "macos")]
	let opener = "open";
	#[cfg(target_os = "linux")]
	let opener = "xdg-open";
	#[cfg(target_os = "windows")]
	let opener = "explorer";

	std::process::Command::new(opener)
		.arg(&path)
		.spawn()
		.map_err(|e| format!("Failed to open file manager: {e}"))?;

	Ok(())
}

/// Provider info returned to the frontend.
#[derive(serde::Serialize)]
pub struct ProviderInfo {
	id: String,
	/// Human-readable display name (from pi-ai built-ins); falls back to id.
	#[serde(rename = "name")]
	name: String,
	has_api_key: bool,
	auth_type: Option<String>, // "api_key" | "oauth"
	is_custom: bool,
	protocol: Option<String>,
	model_count: usize,
}

#[derive(Deserialize)]
pub struct CustomProviderModelInput {
	id: String,
	name: Option<String>,
}

#[derive(Deserialize)]
pub struct CustomProviderInput {
	id: String,
	name: Option<String>,
	protocol: String,
	base_url: String,
	api_key: String,
	models: Vec<CustomProviderModelInput>,
}

#[derive(Serialize)]
pub struct CustomProviderTestResult {
	ok: bool,
	protocol: String,
	model: String,
	message: String,
	response: Option<String>,
	status: Option<u16>,
	duration_ms: u128,
}

fn agent_dir() -> Result<PathBuf, String> {
	if let Some(configured) = std::env::var_os("PIZZA_CODING_AGENT_DIR") {
		let configured = configured.to_string_lossy().to_string();
		if configured == "~" {
			return home_dir().ok_or_else(|| "could not determine home directory".to_string());
		}
		if let Some(rest) = configured.strip_prefix("~/") {
			return home_dir()
				.map(|home| home.join(rest))
				.ok_or_else(|| "could not determine home directory".to_string());
		}
		return Ok(PathBuf::from(configured));
	}
	home_dir()
		.map(|home| home.join(".pizza").join("agent"))
		.ok_or_else(|| "could not determine home directory".to_string())
}

fn auth_path() -> Result<PathBuf, String> {
	Ok(agent_dir()?.join("auth.json"))
}

fn models_path() -> Result<PathBuf, String> {
	Ok(agent_dir()?.join("models.json"))
}

fn ensure_agent_dir() -> Result<PathBuf, String> {
	let dir = agent_dir()?;
	if !dir.exists() {
		std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir: {e}"))?;
	}
	Ok(dir)
}

fn read_json_object(path: &PathBuf) -> serde_json::Map<String, Value> {
	if !path.exists() {
		return serde_json::Map::new();
	}
	let Ok(raw) = std::fs::read_to_string(path) else {
		return serde_json::Map::new();
	};
	let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
		return serde_json::Map::new();
	};
	parsed.as_object().cloned().unwrap_or_default()
}

fn write_json_object(path: &PathBuf, data: serde_json::Map<String, Value>) -> Result<(), String> {
	let json = serde_json::to_string_pretty(&Value::Object(data))
		.map_err(|e| format!("serialize: {e}"))?;
	std::fs::write(path, &json).map_err(|e| format!("write: {e}"))?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
	}
	Ok(())
}

fn read_models_providers() -> serde_json::Map<String, Value> {
	let Ok(path) = models_path() else {
		return serde_json::Map::new();
	};
	let root = read_json_object(&path);
	root.get("providers")
		.and_then(|v| v.as_object())
		.cloned()
		.unwrap_or_default()
}

fn write_models_providers(providers: serde_json::Map<String, Value>) -> Result<(), String> {
	ensure_agent_dir()?;
	let path = models_path()?;
	let mut root = read_json_object(&path);
	root.insert("providers".to_string(), Value::Object(providers));
	write_json_object(&path, root)
}

fn normalize_provider_id(value: &str) -> Result<String, String> {
	let trimmed = value.trim();
	if trimmed.is_empty() {
		return Err("Provider id is required".to_string());
	}
	let valid = trimmed
		.chars()
		.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
	if !valid {
		return Err(
			"Provider id may only contain letters, numbers, dot, dash, and underscore".to_string(),
		);
	}
	Ok(trimmed.to_string())
}

fn api_for_protocol(protocol: &str) -> Result<&'static str, String> {
	match protocol.trim() {
		"openai" => Ok("openai-completions"),
		"anthropic" => Ok("anthropic-messages"),
		other => Err(format!("Unsupported custom provider protocol: {other}")),
	}
}

fn protocol_for_api(api: &str) -> Option<String> {
	match api {
		"openai-completions" | "openai-responses" => Some("openai".to_string()),
		"anthropic-messages" => Some("anthropic".to_string()),
		_ => None,
	}
}

fn normalize_base_url(value: &str) -> Result<String, String> {
	let trimmed = value.trim();
	if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
		return Err("Base URL must start with http:// or https://".to_string());
	}
	if trimmed.chars().any(|c| c.is_whitespace()) {
		return Err("Base URL cannot contain whitespace".to_string());
	}
	Ok(trimmed.trim_end_matches('/').to_string())
}

fn first_custom_model_id(input: &CustomProviderInput) -> Result<String, String> {
	input
		.models
		.iter()
		.map(|model| model.id.trim())
		.find(|id| !id.is_empty())
		.map(|id| id.to_string())
		.ok_or_else(|| "At least one model id is required".to_string())
}

fn join_api_path(base_url: &str, suffix: &str) -> String {
	let base = base_url.trim_end_matches('/');
	if base.ends_with("/v1") && suffix.starts_with("/v1/") {
		format!("{}{}", base, &suffix[3..])
	} else {
		format!("{}{}", base, suffix)
	}
}

fn shorten_response_text(value: &str) -> String {
	const MAX_CHARS: usize = 360;
	let trimmed = value.trim();
	if trimmed.chars().count() <= MAX_CHARS {
		return trimmed.to_string();
	}
	let shortened: String = trimmed.chars().take(MAX_CHARS).collect();
	format!("{shortened}...")
}

fn extract_anthropic_text(value: &Value) -> Option<String> {
	value
		.get("content")
		.and_then(|content| content.as_array())
		.and_then(|blocks| {
			blocks.iter().find_map(|block| {
				block
					.get("text")
					.and_then(|text| text.as_str())
					.map(shorten_response_text)
			})
		})
}

fn extract_openai_text(value: &Value) -> Option<String> {
	value
		.get("choices")
		.and_then(|choices| choices.as_array())
		.and_then(|choices| choices.first())
		.and_then(|choice| choice.get("message"))
		.and_then(|message| message.get("content"))
		.and_then(|content| content.as_str())
		.map(shorten_response_text)
}

fn extract_error_text(value: &Value) -> Option<String> {
	if let Some(message) = value
		.get("error")
		.and_then(|error| error.get("message").or_else(|| error.get("type")))
		.and_then(|message| message.as_str())
	{
		return Some(shorten_response_text(message));
	}
	value
		.get("message")
		.and_then(|message| message.as_str())
		.map(shorten_response_text)
}

fn custom_provider_info(
	id: &str,
	config: &Value,
	auth_data: &serde_json::Map<String, Value>,
) -> Option<ProviderInfo> {
	let obj = config.as_object()?;
	let models = obj
		.get("models")
		.and_then(|v| v.as_array())
		.map(|arr| arr.len())
		.unwrap_or(0);
	if models == 0 {
		return None;
	}
	let api = obj.get("api").and_then(|v| v.as_str()).unwrap_or("");
	let protocol = protocol_for_api(api);
	let name = obj
		.get("name")
		.and_then(|v| v.as_str())
		.filter(|v| !v.trim().is_empty())
		.unwrap_or(id)
		.to_string();
	let cred = auth_data.get(id);
	let auth_type = cred
		.and_then(|c| c.get("type"))
		.and_then(|t| t.as_str())
		.map(|s| s.to_string());
	Some(ProviderInfo {
		id: id.to_string(),
		name,
		has_api_key: cred.is_some(),
		auth_type,
		is_custom: true,
		protocol,
		model_count: models,
	})
}

/// Load built-in provider {id -> display name} map from the generated
/// `providers.json` (sourced from pi-ai at build time). Returns an empty map
/// on any failure — callers fall back to the raw id as the display name.
///
/// Search order mirrors `resolve_pizza_command`:
///   1. Packaged: `<resource_dir>/providers.json`
///   2. Dev:      `<CARGO_MANIFEST_DIR>/../../dist/providers.json`
fn load_builtin_providers(app: &AppHandle) -> HashMap<String, String> {
	let candidates: Vec<PathBuf> = {
		let mut v = Vec::new();
		if let Ok(resource_dir) = app.path().resource_dir() {
			v.push(resource_dir.join("providers.json"));
		}
		v.push(
			PathBuf::from(env!("CARGO_MANIFEST_DIR"))
				.join("..")
				.join("..")
				.join("dist")
				.join("providers.json"),
		);
		v
	};

	for path in candidates {
		match std::fs::read_to_string(&path) {
			Ok(raw) => match serde_json::from_str::<HashMap<String, String>>(&raw) {
				Ok(parsed) => return parsed,
				Err(e) => log_file(&format!(
					"load_builtin_providers: {} exists but failed to parse JSON: {}",
					path.display(),
					e
				)),
			},
			Err(_) => {} // file missing — try next candidate
		}
	}
	log_file("load_builtin_providers: no readable providers.json found in any candidate path");
	HashMap::new()
}

/// List all known providers and their auth status from auth.json.
/// The built-in provider list and display names come from the generated
/// `providers.json` (pi-ai catalog). Providers present in auth.json but not
/// in the catalog (custom providers) are appended with their raw id as name.
#[tauri::command]
pub async fn list_providers(app: AppHandle) -> Result<Vec<ProviderInfo>, String> {
	let auth_data = read_json_object(&auth_path()?);
	let model_providers = read_models_providers();

	// Built-in providers: { id -> display name } from pi-ai (generated JSON).
	// Preserve catalog order by reading the file as an ordered map.
	let builtin_names: HashMap<String, String> = load_builtin_providers(&app);
	// Preserve stable display order: sorted by id.
	let mut builtin_ids: Vec<&String> = builtin_names.keys().collect();
	builtin_ids.sort();

	let mut providers: Vec<ProviderInfo> = Vec::new();

	for id in &builtin_ids {
		let cred = auth_data.get(*id);
		let has_api_key = cred.is_some();
		let auth_type = cred
			.and_then(|c| c.get("type"))
			.and_then(|t| t.as_str())
			.map(|s| s.to_string());
		providers.push(ProviderInfo {
			id: (*id).clone(),
			name: builtin_names
				.get(*id)
				.cloned()
				.unwrap_or_else(|| (*id).clone()),
			has_api_key,
			auth_type,
			is_custom: false,
			protocol: None,
			model_count: 0,
		});
	}

	// Add custom providers declared in models.json.
	let mut custom_ids: Vec<&String> = model_providers.keys().collect();
	custom_ids.sort();
	for id in custom_ids {
		if builtin_names.contains_key(id) {
			continue;
		}
		if let Some(info) = custom_provider_info(id, &model_providers[id], &auth_data) {
			providers.push(info);
		}
	}

	// Add any auth-only custom providers not in builtin/models list.
	for (key, _val) in &auth_data {
		if !builtin_names.contains_key(key) && !model_providers.contains_key(key) {
			let cred = auth_data.get(key);
			let auth_type = cred
				.and_then(|c| c.get("type"))
				.and_then(|t| t.as_str())
				.map(|s| s.to_string());
			providers.push(ProviderInfo {
				id: key.clone(),
				name: key.clone(),
				has_api_key: true,
				auth_type,
				is_custom: true,
				protocol: None,
				model_count: 0,
			});
		}
	}

	Ok(providers)
}

/// Set an API key for a provider in auth.json.
#[tauri::command]
pub async fn set_provider_api_key(
	app: AppHandle,
	state: tauri::State<'_, BridgeState>,
	provider: String,
	api_key: String,
) -> Result<(), String> {
	ensure_agent_dir()?;
	let auth_path = auth_path()?;
	let mut auth_data = read_json_object(&auth_path);

	// Set the API key
	auth_data.insert(
		provider.clone(),
		serde_json::json!({ "type": "api_key", "key": api_key }),
	);

	write_json_object(&auth_path, auth_data)?;

	log_file(&format!("set_provider_api_key: set key for {}", provider));
	// auth.json is shared across all workspaces: tell every running sidecar
	// to reload its in-memory credentials so a model switch uses this new key.
	broadcast_to_all_sidecars(&state, "reload_providers");
	broadcast_to_all_channels(state.inner(), "reload_providers").await;
	schedule_remote_provider_provisioning(&app, Duration::ZERO);
	Ok(())
}

/// Remove a provider's credentials from auth.json.
#[tauri::command]
pub async fn remove_provider_api_key(
	app: AppHandle,
	state: tauri::State<'_, BridgeState>,
	provider: String,
) -> Result<(), String> {
	let auth_path = auth_path()?;

	if !auth_path.exists() {
		return Ok(()); // Nothing to remove
	}

	let raw = std::fs::read_to_string(&auth_path).map_err(|e| format!("read: {e}"))?;
	let mut parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("parse: {e}"))?;

	if let Some(obj) = parsed.as_object_mut() {
		obj.remove(&provider);
	}

	let json = serde_json::to_string_pretty(&parsed).map_err(|e| format!("serialize: {e}"))?;
	std::fs::write(&auth_path, &json).map_err(|e| format!("write: {e}"))?;

	log_file(&format!(
		"remove_provider_api_key: removed key for {}",
		provider
	));
	// Notify every sidecar so they drop the now-removed credential from
	// their in-memory cache (otherwise auth still resolves as configured).
	broadcast_to_all_sidecars(&state, "reload_providers");
	broadcast_to_all_channels(state.inner(), "reload_providers").await;
	schedule_remote_provider_provisioning(&app, Duration::ZERO);
	Ok(())
}

#[tauri::command]
pub async fn save_custom_provider(
	app: AppHandle,
	state: tauri::State<'_, BridgeState>,
	input: CustomProviderInput,
) -> Result<(), String> {
	ensure_agent_dir()?;

	let provider_id = normalize_provider_id(&input.id)?;
	let api = api_for_protocol(&input.protocol)?;
	let base_url = normalize_base_url(&input.base_url)?;
	let api_key = input.api_key.trim();
	if api_key.is_empty() {
		return Err("API key is required".to_string());
	}

	let mut models: Vec<Value> = Vec::new();
	for model in input.models {
		let id = model.id.trim();
		if id.is_empty() {
			continue;
		}
		let model_name = model
			.name
			.as_deref()
			.map(str::trim)
			.filter(|value| !value.is_empty())
			.unwrap_or(id);
		models.push(serde_json::json!({
			"id": id,
			"name": model_name,
			"reasoning": false,
			"input": ["text"],
			"contextWindow": 128000,
			"maxTokens": 16384
		}));
	}
	if models.is_empty() {
		return Err("At least one model id is required".to_string());
	}

	let display_name = input
		.name
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.unwrap_or(&provider_id);
	let mut providers = read_models_providers();
	providers.insert(
		provider_id.clone(),
		serde_json::json!({
			"name": display_name,
			"baseUrl": base_url,
			"api": api,
			"models": models
		}),
	);
	write_models_providers(providers)?;

	let auth_path = auth_path()?;
	let mut auth_data = read_json_object(&auth_path);
	auth_data.insert(
		provider_id.clone(),
		serde_json::json!({ "type": "api_key", "key": api_key }),
	);
	write_json_object(&auth_path, auth_data)?;

	log_file(&format!("save_custom_provider: saved {}", provider_id));
	broadcast_to_all_sidecars(&state, "reload_providers");
	broadcast_to_all_channels(state.inner(), "reload_providers").await;
	schedule_remote_provider_provisioning(&app, Duration::ZERO);
	Ok(())
}

#[tauri::command]
pub async fn test_custom_provider(
	input: CustomProviderInput,
) -> Result<CustomProviderTestResult, String> {
	let protocol = input.protocol.trim().to_string();
	let _api = api_for_protocol(&protocol)?;
	let base_url = normalize_base_url(&input.base_url)?;
	let api_key = input.api_key.trim().to_string();
	if api_key.is_empty() {
		return Err("API key is required".to_string());
	}
	let model_id = first_custom_model_id(&input)?;
	let started = std::time::Instant::now();
	let client = reqwest::Client::builder()
		.timeout(Duration::from_secs(60))
		.build()
		.map_err(|e| format!("create client: {e}"))?;

	let (url, request) = if protocol == "anthropic" {
		let url = join_api_path(&base_url, "/v1/messages");
		let body = serde_json::json!({
			"model": model_id,
			"max_tokens": 1024,
			"messages": [{ "role": "user", "content": "hi" }]
		});
		(
			url.clone(),
			client
				.post(url)
				.header("x-api-key", api_key)
				.header("anthropic-version", "2023-06-01")
				.json(&body),
		)
	} else {
		let url = join_api_path(&base_url, "/chat/completions");
		let body = serde_json::json!({
			"model": model_id,
			"max_tokens": 1024,
			"stream": false,
			"messages": [{ "role": "user", "content": "hi" }]
		});
		(
			url.clone(),
			client.post(url).bearer_auth(api_key).json(&body),
		)
	};

	let response = match request.send().await {
		Ok(response) => response,
		Err(error) => {
			return Ok(CustomProviderTestResult {
				ok: false,
				protocol,
				model: model_id,
				message: format!("Failed to connect to API: {error}"),
				response: None,
				status: None,
				duration_ms: started.elapsed().as_millis(),
			});
		}
	};
	let status = response.status();
	let status_code = status.as_u16();
	let raw_text = match response.text().await {
		Ok(text) => text,
		Err(error) => {
			return Ok(CustomProviderTestResult {
				ok: false,
				protocol,
				model: model_id,
				message: format!("API responded, but the response body could not be read: {error}"),
				response: None,
				status: Some(status_code),
				duration_ms: started.elapsed().as_millis(),
			});
		}
	};
	let parsed = serde_json::from_str::<Value>(&raw_text).ok();

	if !status.is_success() {
		let detail = parsed
			.as_ref()
			.and_then(extract_error_text)
			.unwrap_or_else(|| shorten_response_text(&raw_text));
		return Ok(CustomProviderTestResult {
			ok: false,
			protocol,
			model: model_id,
			message: format!("API returned HTTP {status_code}: {detail}"),
			response: None,
			status: Some(status_code),
			duration_ms: started.elapsed().as_millis(),
		});
	}

	let extracted = parsed.as_ref().and_then(|value| {
		if protocol == "anthropic" {
			extract_anthropic_text(value)
		} else {
			extract_openai_text(value)
		}
	});
	match extracted {
		Some(text) if !text.is_empty() => Ok(CustomProviderTestResult {
			ok: true,
			protocol,
			model: model_id,
			message: "Test completed successfully".to_string(),
			response: Some(text),
			status: Some(status_code),
			duration_ms: started.elapsed().as_millis(),
		}),
		_ => Ok(CustomProviderTestResult {
			ok: false,
			protocol,
			model: model_id,
			message: format!(
				"API connected at {url}, but the response format did not match the selected protocol."
			),
			response: Some(shorten_response_text(&raw_text)),
			status: Some(status_code),
			duration_ms: started.elapsed().as_millis(),
		}),
	}
}

#[tauri::command]
pub async fn remove_custom_provider(
	app: AppHandle,
	state: tauri::State<'_, BridgeState>,
	provider: String,
) -> Result<(), String> {
	let provider_id = normalize_provider_id(&provider)?;
	let mut providers = read_models_providers();
	providers.remove(&provider_id);
	write_models_providers(providers)?;

	let auth_path = auth_path()?;
	if auth_path.exists() {
		let mut auth_data = read_json_object(&auth_path);
		auth_data.remove(&provider_id);
		write_json_object(&auth_path, auth_data)?;
	}

	log_file(&format!("remove_custom_provider: removed {}", provider_id));
	broadcast_to_all_sidecars(&state, "reload_providers");
	broadcast_to_all_channels(state.inner(), "reload_providers").await;
	schedule_remote_provider_provisioning(&app, Duration::ZERO);
	Ok(())
}

/// Set the window background color (for theme adaptation).
#[tauri::command]
pub async fn set_window_background(app: AppHandle, r: u8, g: u8, b: u8) -> Result<(), String> {
	let window = app
		.get_webview_window("main")
		.or_else(|| app.webview_windows().into_iter().next().map(|(_, w)| w));
	if let Some(window) = window {
		window
			.set_background_color(Some(tauri::webview::Color(r, g, b, 255)))
			.map_err(|e| format!("set_background_color: {e}"))?;
	}
	Ok(())
}

/// Transcribe audio data using OpenAI's Whisper API.
///
/// `audio_b64` is base64-encoded audio data (no data-URL prefix).
/// `mime_type` is the audio MIME type (e.g. "audio/webm", "audio/mp4").
/// The OpenAI API key is read from ~/.pizza/agent/auth.json under the "openai" key.
#[tauri::command]
pub async fn transcribe_audio(audio_b64: String, mime_type: String) -> Result<String, String> {
	let api_key = read_api_key("openai").ok_or_else(|| {
		"OpenAI API key not found. Add it in Settings to use voice input.".to_string()
	})?;

	// Decode base64 audio.
	let audio_bytes =
		base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &audio_b64)
			.map_err(|e| format!("base64 decode: {e}"))?;

	// Determine file extension from MIME type.
	let ext = match mime_type.as_str() {
		"audio/webm" => "webm",
		"audio/mp4" | "audio/m4a" => "mp4",
		"audio/ogg" => "ogg",
		"audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
		"audio/mpeg" | "audio/mp3" => "mp3",
		_ => "webm",
	};
	let filename = format!("recording.{}", ext);

	// Build multipart form and POST to OpenAI Whisper API.
	let part = reqwest::multipart::Part::bytes(audio_bytes)
		.file_name(filename)
		.mime_str(&mime_type)
		.map_err(|e| format!("mime_str: {e}"))?;
	let form = reqwest::multipart::Form::new()
		.text("model", "whisper-1")
		.part("file", part);

	let client = reqwest::Client::new();
	let resp = client
		.post("https://api.openai.com/v1/audio/transcriptions")
		.bearer_auth(&api_key)
		.multipart(form)
		.send()
		.await
		.map_err(|e| format!("Whisper request: {e}"))?;

	if !resp.status().is_success() {
		let status = resp.status();
		let body = resp.text().await.unwrap_or_default();
		let msg = if body.len() > 500 {
			format!("Whisper API error ({}): {}...", status, &body[..500])
		} else {
			format!("Whisper API error ({}): {}", status, body)
		};
		log_file(&msg);
		return Err(msg);
	}

	let json: Value = resp
		.json()
		.await
		.map_err(|e| format!("Whisper response parse: {e}"))?;

	let text = json
		.get("text")
		.and_then(|t| t.as_str())
		.unwrap_or("")
		.trim()
		.to_string();

	Ok(text)
}

/// Read a cached inbound voice clip — adapter-written files under
/// `<agentDir>/voice-cache/`. `rel_path` comes from the `<voice file="…">`
/// tag; traversal outside the cache dir is rejected. Returns base64.
#[tauri::command]
pub async fn read_voice_clip(rel_path: String) -> Result<String, String> {
	log_file(&format!("read_voice_clip: {}", rel_path));
	// rel_path is agentDir-relative and already includes the `voice-cache/`
	// prefix (e.g. "voice-cache/lark/<key>.m4a") — resolve against agent_dir,
	// then verify it stays inside voice-cache/.
	let agent = agent_dir()?;
	let cache_dir = agent.join("voice-cache");
	let full = agent.join(&rel_path);
	let canonical = full
		.canonicalize()
		.map_err(|e| format!("voice clip not found: {e}"))?;
	let root = cache_dir
		.canonicalize()
		.map_err(|e| format!("voice-cache dir: {e}"))?;
	if !canonical.starts_with(&root) {
		return Err("voice clip path escapes the cache directory".to_string());
	}
	let metadata = std::fs::metadata(&canonical).map_err(|e| format!("metadata: {e}"))?;
	const MAX_SIZE: u64 = 25 * 1024 * 1024;
	if metadata.len() > MAX_SIZE {
		return Err(format!("voice clip too large ({} bytes)", metadata.len()));
	}
	let bytes = std::fs::read(&canonical).map_err(|e| format!("read: {e}"))?;
	Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Check if a command exists in PATH.
/// Uses `/usr/bin/which` on macOS (since `which` is a shell built-in)
/// and `which` on other platforms.
fn which(cmd: &str) -> bool {
	#[cfg(target_os = "windows")]
	let (which_bin, args) = ("where", vec![cmd]);
	#[cfg(target_os = "macos")]
	let (which_bin, args) = ("/usr/bin/which", vec![cmd]);
	#[cfg(not(any(target_os = "windows", target_os = "macos")))]
	let (which_bin, args) = ("which", vec![cmd]);

	std::process::Command::new(which_bin)
		.args(args)
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null())
		.status()
		.map(|s| s.success())
		.unwrap_or(false)
}

/// Open a file in the user's preferred IDE/editor.
/// Tries common CLI editors (code, cursor, windsurf, zed, etc.) in order,
/// falls back to the system default (`open` on macOS, `xdg-open` on Linux,
/// `start` on Windows).
#[tauri::command]
pub async fn open_in_editor(cwd: String, file_path: String) -> Result<(), String> {
	if remote::is_remote_workspace_key(&cwd) {
		return Err("Open in local editor is unavailable for remote workspaces".to_string());
	}
	let full = resolve_workspace_path(&cwd, Some(&file_path))?;
	if !full.exists() {
		return Err(format!("File does not exist: {}", full.display()));
	}

	let path_str = full.to_string_lossy().to_string();

	// On macOS, try `open -a <App>` for known GUI editors.
	// We use `status()` (not `spawn()`) to detect if the app actually exists.
	#[cfg(target_os = "macos")]
	{
		let apps: &[&str] = &[
			"Cursor",
			"Windsurf",
			"Visual Studio Code",
			"Zed",
			"Sublime Text",
		];
		for app in apps {
			let result = std::process::Command::new("open")
				.arg("-a")
				.arg(app)
				.arg(&path_str)
				.status();
			if let Ok(status) = result {
				if status.success() {
					log::info!("open_in_editor: launched via open -a {} {}", app, path_str);
					return Ok(());
				}
			}
		}
	}

	// Try common CLI editor launchers in priority order.
	let editors: &[&str] = &["cursor", "windsurf", "code", "zed", "subl"];
	for editor in editors {
		if which(editor) {
			log::info!("open_in_editor: launching {} {}", editor, path_str);
			std::process::Command::new(editor)
				.arg(&path_str)
				.spawn()
				.map_err(|e| format!("Failed to launch {editor}: {e}"))?;
			return Ok(());
		}
	}

	// Fallback: use the system default application handler.
	#[cfg(target_os = "macos")]
	let (opener, args) = ("open", vec![path_str]);
	#[cfg(target_os = "linux")]
	let (opener, args) = ("xdg-open", vec![path_str]);
	#[cfg(target_os = "windows")]
	let (opener, args) = (
		"cmd",
		vec![
			"/C".to_string(),
			"start".to_string(),
			"".to_string(),
			path_str,
		],
	);

	std::process::Command::new(opener)
		.args(&args)
		.status()
		.map_err(|e| format!("Failed to open file: {e}"))?;

	Ok(())
}

/// Reveal a file or directory in the system file manager (Finder on macOS,
/// Explorer on Windows, etc.). When `sub_path` points to a file, the file's
/// containing directory is opened with the file selected (macOS uses
/// `open -R`); when it points to a directory, the directory itself is
/// opened.
#[tauri::command]
pub async fn reveal_path(cwd: String, sub_path: String) -> Result<(), String> {
	if remote::is_remote_workspace_key(&cwd) {
		return Err(
			"Reveal in local file manager is unavailable for remote workspaces".to_string(),
		);
	}
	let full = resolve_workspace_path(&cwd, Some(&sub_path))?;
	if !full.exists() {
		return Err(format!("Path does not exist: {}", full.display()));
	}

	let path_str = full.to_string_lossy().to_string();

	#[cfg(target_os = "macos")]
	{
		// `open -R <file>` reveals the file in Finder (selected). For a
		// directory, fall back to `open <dir>` since `-R` requires an
		// existing file.
		if full.is_file() {
			std::process::Command::new("open")
				.arg("-R")
				.arg(&path_str)
				.spawn()
				.map_err(|e| format!("Failed to reveal file: {e}"))?;
			return Ok(());
		}
	}

	#[cfg(target_os = "macos")]
	let opener = "open";
	#[cfg(target_os = "linux")]
	let opener = "xdg-open";
	#[cfg(target_os = "windows")]
	let opener = "explorer";

	std::process::Command::new(opener)
		.arg(&path_str)
		.spawn()
		.map_err(|e| format!("Failed to open file manager: {e}"))?;

	Ok(())
}

// --- File explorer (list_dir / read_file) ---

/// Directories to skip when listing (to avoid huge / irrelevant trees).
const SKIP_DIRS: &[&str] = &[
	".git",
	"node_modules",
	"target",
	".next",
	".cache",
	".turbo",
	"dist",
	"build",
	".DS_Store",
];

#[derive(serde::Serialize, serde::Deserialize)]
pub struct DirEntry {
	pub name: String,
	pub path: String,
	pub is_dir: bool,
	pub size: u64,
}

/// Resolve `cwd` (expanding `~`) and join `sub_path` if provided.
fn resolve_workspace_path(cwd: &str, sub_path: Option<&str>) -> Result<PathBuf, String> {
	let expanded = expand_tilde(cwd);
	let base = PathBuf::from(&expanded);
	let full = match sub_path {
		Some(s) if !s.is_empty() => base.join(s),
		_ => base,
	};
	// Canonicalize to resolve any `..` etc., but fall back to the raw path.
	Ok(full.canonicalize().unwrap_or(full))
}

/// List entries in a directory within the workspace. `sub_path` is relative
/// to `cwd`. Directories in `SKIP_DIRS` are excluded.
#[tauri::command]
pub async fn list_dir(
	state: tauri::State<'_, BridgeState>,
	cwd: String,
	sub_path: Option<String>,
) -> Result<Vec<DirEntry>, String> {
	if let Some(value) = remote_fs_request(
		state.inner(),
		&cwd,
		"list_dir",
		serde_json::json!({ "subPath": sub_path }),
	)
	.await?
	{
		return serde_json::from_value(value)
			.map_err(|e| format!("Invalid remote list_dir response: {e}"));
	}
	let dir = resolve_workspace_path(&cwd, sub_path.as_deref())?;
	if !dir.exists() {
		return Err(format!("Directory does not exist: {}", dir.display()));
	}
	if !dir.is_dir() {
		return Err(format!("Not a directory: {}", dir.display()));
	}

	let base = resolve_workspace_path(&cwd, None)?;
	let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;

	let mut result: Vec<DirEntry> = Vec::new();
	for entry in entries.filter_map(|e| e.ok()) {
		let file_name = entry.file_name().to_string_lossy().to_string();
		// Skip known huge / irrelevant directories.
		if SKIP_DIRS.contains(&file_name.as_str()) {
			continue;
		}
		let file_type = entry.file_type().map_err(|e| format!("file_type: {e}"))?;
		let full_path = entry.path();
		// Compute relative path from workspace root.
		let rel = full_path
			.strip_prefix(&base)
			.map(|p| p.to_string_lossy().to_string())
			.unwrap_or_else(|_| file_name.clone());
		let size = if file_type.is_dir() {
			0
		} else {
			entry.metadata().map(|m| m.len()).unwrap_or(0)
		};
		result.push(DirEntry {
			name: file_name,
			path: rel,
			is_dir: file_type.is_dir(),
			size,
		});
	}

	// Sort: directories first, then alphabetical.
	result.sort_by(|a, b| {
		b.is_dir
			.cmp(&a.is_dir)
			.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
	});

	Ok(result)
}

/// Read a file's text content within the workspace. `file_path` is relative
/// to `cwd`. Files larger than 2 MB are rejected to avoid UI overload.
#[tauri::command]
pub async fn read_file(
	state: tauri::State<'_, BridgeState>,
	cwd: String,
	file_path: String,
) -> Result<String, String> {
	if let Some(value) = remote_fs_request(
		state.inner(),
		&cwd,
		"read_file",
		serde_json::json!({ "filePath": file_path }),
	)
	.await?
	{
		return serde_json::from_value(value)
			.map_err(|e| format!("Invalid remote read_file response: {e}"));
	}
	let full = resolve_workspace_path(&cwd, Some(&file_path))?;
	if !full.exists() {
		return Err(format!("File does not exist: {}", full.display()));
	}
	if full.is_dir() {
		return Err(format!("Path is a directory: {}", full.display()));
	}
	let metadata = std::fs::metadata(&full).map_err(|e| format!("metadata: {e}"))?;
	const MAX_SIZE: u64 = 2 * 1024 * 1024; // 2 MB
	if metadata.len() > MAX_SIZE {
		return Err(format!(
			"File is too large ({} bytes, max {} bytes)",
			metadata.len(),
			MAX_SIZE
		));
	}
	std::fs::read_to_string(&full).map_err(|e| format!("read_to_string: {e}"))
}

// --- Recursive file search (for the composer @ mention menu) ---

#[derive(serde::Serialize, serde::Deserialize)]
pub struct FileSearchEntry {
	/// Basename of the file.
	pub name: String,
	/// Path relative to the workspace root (e.g. "src/components/Terminal.tsx").
	pub path: String,
	pub is_dir: bool,
}

/// Recursively walk the workspace (breadth-first so shallower files rank
/// first), skipping `SKIP_DIRS`. Returns files whose relative path contains
/// `query` (case-insensitive) when provided, capped at `limit` (default 1000).
/// Directories are traversed but not returned — the `@` menu is for files;
/// the file explorer (`list_dir`) already handles directory navigation.
#[tauri::command]
pub async fn search_files(
	state: tauri::State<'_, BridgeState>,
	cwd: String,
	query: Option<String>,
	limit: Option<u32>,
) -> Result<Vec<FileSearchEntry>, String> {
	if let Some(value) = remote_fs_request(
		state.inner(),
		&cwd,
		"search_files",
		serde_json::json!({ "query": query, "limit": limit }),
	)
	.await?
	{
		return serde_json::from_value(value)
			.map_err(|e| format!("Invalid remote search_files response: {e}"));
	}
	use std::collections::VecDeque;
	let base = resolve_workspace_path(&cwd, None)?;
	if !base.is_dir() {
		return Err(format!("Not a directory: {}", base.display()));
	}
	let q = query.map(|s| s.to_lowercase()).filter(|s| !s.is_empty());
	let cap = limit.unwrap_or(1000).max(1) as usize;

	let mut out: Vec<FileSearchEntry> = Vec::with_capacity(cap.min(256));
	let mut queue: VecDeque<PathBuf> = VecDeque::new();
	queue.push_back(base.clone());

	while let Some(dir) = queue.pop_front() {
		if out.len() >= cap {
			break;
		}
		let entries = match std::fs::read_dir(&dir) {
			Ok(e) => e,
			Err(_) => continue,
		};
		for entry in entries.flatten() {
			if out.len() >= cap {
				break;
			}
			let file_name = entry.file_name().to_string_lossy().to_string();
			if SKIP_DIRS.contains(&file_name.as_str()) {
				continue;
			}
			let ft = match entry.file_type() {
				Ok(t) => t,
				Err(_) => continue,
			};
			let full = entry.path();
			let rel = full
				.strip_prefix(&base)
				.map(|p| p.to_string_lossy().to_string())
				.unwrap_or_else(|_| file_name.clone());
			if ft.is_dir() {
				// Recurse into subdirectories (BFS); dirs are not surfaced as
				// results to keep the menu focused on files.
				queue.push_back(full);
				continue;
			}
			if let Some(ref qstr) = q {
				if !rel.to_lowercase().contains(qstr) {
					continue;
				}
			}
			out.push(FileSearchEntry {
				name: file_name,
				path: rel,
				is_dir: false,
			});
		}
	}

	// Order by depth (shallowest first) then by path, so root-level files
	// rank ahead of deeply nested ones — matching IDE Quick Open behaviour.
	out.sort_by(|a, b| {
		let da = a.path.matches('/').count();
		let db = b.path.matches('/').count();
		da.cmp(&db).then_with(|| a.path.cmp(&b.path))
	});
	Ok(out)
}

// --- Git status / diff (right dock "Git" tab) ---

/// Run `git` inside `cwd`, returning stdout as a String. Errors out if git is
/// missing or the command fails (e.g. cwd is not a git repo).
fn run_git_capture(cwd: &str, args: &[&str]) -> Result<String, String> {
	let dir = resolve_workspace_path(cwd, None)?;
	let output = std::process::Command::new("git")
		.args(args)
		.current_dir(&dir)
		.output()
		.map_err(|e| format!("failed to spawn git: {e}"))?;
	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
		// `git rev-parse --is-inside-work-tree` returns non-zero + "fatal: not a git
		// repository" outside a repo — surface a clean, detectable error.
		return Err(if stderr.is_empty() {
			format!("git {} failed", args.join(" "))
		} else {
			stderr
		});
	}
	Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// One row of `git status --porcelain`. `xy` is the two-char status code, `path`
/// is the file path (relative to repo root), and `orig_path` is the original
/// path for a rename/copy (the `R`/`C` codes), if any. `additions`/`deletions`
/// come from `git diff --numstat` and are `None` for untracked/binary files.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct GitStatusEntry {
	pub xy: String,
	pub path: String,
	pub orig_path: Option<String>,
	pub additions: Option<u32>,
	pub deletions: Option<u32>,
}

/// Parse `git diff --numstat -z HEAD` into a path → (additions, deletions) map.
/// Binary files report `-` for both counts and are skipped. Rename entries in
/// `-z` numstat are emitted as `adds\tdels\t\0<old>\0<new>\0`; we key on the
/// new path so it lines up with the porcelain entry.
fn parse_numstat(raw: &str) -> HashMap<String, (u32, u32)> {
	let mut map = HashMap::new();
	let mut fields = raw.split('\0').filter(|f| !f.is_empty()).peekable();
	while let Some(field) = fields.next() {
		let mut parts = field.splitn(3, '\t');
		let adds = parts.next().unwrap_or("");
		let dels = parts.next().unwrap_or("");
		let path = parts.next().unwrap_or("");
		// Binary files report "-"; skip them (no line counts to show).
		let (Ok(adds), Ok(dels)) = (adds.parse::<u32>(), dels.parse::<u32>()) else {
			// Still need to consume the rename's two path fields.
			if path.is_empty() {
				fields.next();
				fields.next();
			}
			continue;
		};
		if path.is_empty() {
			// Rename/copy: the old and new paths follow as separate NUL fields.
			let _old = fields.next();
			if let Some(new) = fields.next() {
				map.insert(new.to_string(), (adds, dels));
			}
		} else {
			map.insert(path.to_string(), (adds, dels));
		}
	}
	map
}

/// Parse `git status --porcelain=v1 -z` output. Each record is
/// `XY <path>\0`, except rename/copy records which are `XY <new>\0<old>\0`,
/// so the old path must be consumed as a separate field.
fn parse_porcelain(raw: &str, stats: &HashMap<String, (u32, u32)>) -> Vec<GitStatusEntry> {
	let mut entries = Vec::new();
	let mut fields = raw.split('\0').filter(|f| !f.is_empty());
	while let Some(record) = fields.next() {
		if record.len() < 3 {
			continue;
		}
		let xy = record[..2].to_string();
		let path = record[3..].to_string();
		// Rename/copy records are followed by the original path.
		let orig_path = if xy.starts_with('R') || xy.starts_with('C') {
			fields.next().map(|s| s.to_string())
		} else {
			None
		};
		let (additions, deletions) = match stats.get(&path) {
			Some((a, d)) => (Some(*a), Some(*d)),
			None => (None, None),
		};
		entries.push(GitStatusEntry {
			xy,
			path,
			orig_path,
			additions,
			deletions,
		});
	}
	entries
}

/// Summary of the current git repo state for the right-dock Git tab.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct GitStatusSummary {
	/// True if `cwd` is inside a git work tree.
	pub is_repo: bool,
	/// Current branch name (HEAD), or empty if detached.
	pub branch: String,
	/// Short commit hash of HEAD, or empty.
	pub head: String,
	/// Subject line of HEAD commit, or empty.
	pub head_subject: String,
	/// Upstream tracking branch (e.g. `origin/main`), if any.
	pub upstream: String,
	/// Counts of commits ahead/behind upstream (0 when no upstream).
	pub ahead: u32,
	pub behind: u32,
	/// Porcelain status entries (working tree + index).
	pub entries: Vec<GitStatusEntry>,
	/// Number of untracked files (entries with `??`).
	pub untracked: u32,
	/// Number of staged changes (index differs from HEAD).
	pub staged: u32,
	/// Number of unstaged changes (worktree differs from index).
	pub unstaged: u32,
}

/// Return a `GitStatusSummary` for `cwd`. If `cwd` is not a git repo, returns
/// `is_repo: false` with empty fields (no error) so the UI can hide the tab.
#[tauri::command]
pub async fn git_status(
	state: tauri::State<'_, BridgeState>,
	cwd: String,
) -> Result<GitStatusSummary, String> {
	if let Some(value) =
		remote_fs_request(state.inner(), &cwd, "git_status", serde_json::json!({})).await?
	{
		return serde_json::from_value(value)
			.map_err(|e| format!("Invalid remote git_status response: {e}"));
	}
	// Cheap repo check first — non-zero exit means "not a repo"; we surface that
	// as a successful `is_repo: false` rather than an error.
	let inside = run_git_capture(&cwd, &["rev-parse", "--is-inside-work-tree"]);
	let is_repo = match inside {
		Ok(s) => s.trim() == "true",
		Err(_) => {
			return Ok(GitStatusSummary {
				is_repo: false,
				branch: String::new(),
				head: String::new(),
				head_subject: String::new(),
				upstream: String::new(),
				ahead: 0,
				behind: 0,
				entries: Vec::new(),
				untracked: 0,
				staged: 0,
				unstaged: 0,
			})
		}
	};
	if !is_repo {
		return Ok(GitStatusSummary {
			is_repo: false,
			branch: String::new(),
			head: String::new(),
			head_subject: String::new(),
			upstream: String::new(),
			ahead: 0,
			behind: 0,
			entries: Vec::new(),
			untracked: 0,
			staged: 0,
			unstaged: 0,
		});
	}

	// Branch name (empty when detached).
	let branch = run_git_capture(&cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"])
		.map(|s| s.trim().to_string())
		.unwrap_or_default();

	// HEAD short hash + subject in one call.
	let head_line = run_git_capture(&cwd, &["log", "-1", "--format=%h%x09%s"])
		.map(|s| s.trim().to_string())
		.unwrap_or_default();
	let (head, head_subject) = head_line
		.split_once('\t')
		.map(|(h, s)| (h.to_string(), s.to_string()))
		.unwrap_or((String::new(), String::new()));

	// Upstream tracking branch, if any.
	let upstream = run_git_capture(&cwd, &["rev-parse", "--abbrev-ref", "@{upstream}"])
		.map(|s| s.trim().to_string())
		.unwrap_or_default();

	// Ahead/behind counts relative to upstream, e.g. "5\t2".
	let (ahead, behind) = if !upstream.is_empty() {
		run_git_capture(
			&cwd,
			&["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
		)
		.ok()
		.and_then(|s| {
			let s = s.trim();
			let (a, b) = s.split_once('\t')?;
			let a = a.parse::<u32>().ok()?;
			let b = b.parse::<u32>().ok()?;
			Some((a, b))
		})
		.unwrap_or((0, 0))
	} else {
		(0, 0)
	};

	// Per-file line counts (staged + unstaged vs HEAD). Best-effort: an empty
	// repo has no HEAD to diff against, so failures just mean "no stats".
	let stats = run_git_capture(&cwd, &["diff", "--numstat", "-z", "HEAD"])
		.map(|raw| parse_numstat(&raw))
		.unwrap_or_default();

	// Porcelain status: `-z` separates records with NUL and leaves paths unquoted.
	let raw = run_git_capture(&cwd, &["status", "--porcelain=v1", "-z"])?;
	let entries = parse_porcelain(&raw, &stats);

	let mut untracked: u32 = 0;
	let mut staged: u32 = 0;
	let mut unstaged: u32 = 0;
	for entry in &entries {
		let bytes = entry.xy.as_bytes();
		if entry.xy == "??" {
			untracked += 1;
			continue;
		}
		if bytes[0] != b' ' && bytes[0] != b'?' {
			staged += 1;
		}
		if bytes[1] != b' ' && bytes[1] != b'?' {
			unstaged += 1;
		}
	}

	Ok(GitStatusSummary {
		is_repo: true,
		branch,
		head,
		head_subject,
		upstream,
		ahead,
		behind,
		entries,
		untracked,
		staged,
		unstaged,
	})
}

/// Return a unified diff for `path` (relative to `cwd`), selected by `mode`:
///
/// - `"staged"`   — index vs HEAD (`git diff --cached`)
/// - `"worktree"` — working tree vs index (`git diff`)
/// - `"untracked"`— the whole file rendered as additions
///   (`git diff --no-index /dev/null <path>`), since an untracked file has no
///   git-side counterpart to diff against
///
/// An empty `path` yields the diff for the whole repo (not valid for
/// `"untracked"`). Note `--no-index` exits 1 when the files differ, which is
/// the normal case here, so that mode bypasses the exit-status check.
#[tauri::command]
pub async fn git_diff(
	state: tauri::State<'_, BridgeState>,
	cwd: String,
	path: String,
	mode: String,
) -> Result<String, String> {
	if let Some(value) = remote_fs_request(
		state.inner(),
		&cwd,
		"git_diff",
		serde_json::json!({ "path": path, "mode": mode }),
	)
	.await?
	{
		return serde_json::from_value(value)
			.map_err(|e| format!("Invalid remote git_diff response: {e}"));
	}
	if mode == "untracked" {
		if path.is_empty() {
			return Ok(String::new());
		}
		let dir = resolve_workspace_path(&cwd, None)?;
		let output = std::process::Command::new("git")
			.args(["diff", "--no-index", "--", "/dev/null", &path])
			.current_dir(&dir)
			.output()
			.map_err(|e| format!("failed to spawn git: {e}"))?;
		// `--no-index` returns 1 whenever the inputs differ; only treat a
		// missing stdout *and* non-empty stderr as a real failure.
		let stdout = String::from_utf8_lossy(&output.stdout).to_string();
		if stdout.is_empty() {
			let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
			if !stderr.is_empty() {
				return Err(stderr);
			}
		}
		return Ok(stdout);
	}

	let mut args: Vec<&str> = vec!["diff"];
	if mode == "staged" {
		args.push("--cached");
	}
	args.push("--");
	if !path.is_empty() {
		args.push(&path);
	}
	run_git_capture(&cwd, &args)
}

/// One entry from `git branch --list`, with its name and tracking info.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct GitBranchEntry {
	/// Branch name (without the `*` or `remotes/` prefix).
	pub name: String,
	/// True if this is the current branch (HEAD).
	pub is_current: bool,
	/// True if this is a remote-tracking branch (e.g. `origin/main`).
	pub is_remote: bool,
	/// Upstream tracking ref, if any (e.g. `origin/main`).
	pub upstream: Option<String>,
}

/// Parse `git for-each-ref --format=%(HEAD)\t%(refname)\t%(upstream:short)` output
/// (one ref per line, tab-separated) into branch entries. Using the full
/// `refname` (`refs/heads/…` vs `refs/remotes/…`) is the only reliable way to
/// tell local from remote — a short name like `feature/x` contains a slash but
/// is local. The symbolic `refs/remotes/<remote>/HEAD` ref is skipped.
fn parse_branches(raw: &str) -> Vec<GitBranchEntry> {
	let mut branches = Vec::new();
	for line in raw.lines() {
		if line.is_empty() {
			continue;
		}
		let mut parts = line.splitn(3, '\t');
		let head_marker = parts.next().unwrap_or("");
		let refname = parts.next().unwrap_or("");
		let upstream = parts.next().filter(|s| !s.is_empty());
		let (is_remote, name) = if let Some(n) = refname.strip_prefix("refs/remotes/") {
			// Skip the symbolic per-remote HEAD pointer (refs/remotes/origin/HEAD).
			if n.ends_with("/HEAD") {
				continue;
			}
			(true, n.to_string())
		} else if let Some(n) = refname.strip_prefix("refs/heads/") {
			(false, n.to_string())
		} else {
			// Tags and anything else are not branches — ignore them.
			continue;
		};
		branches.push(GitBranchEntry {
			name,
			is_current: head_marker == "*",
			is_remote,
			upstream: upstream.map(|s| s.to_string()),
		});
	}
	branches
}

/// List all branches (local + remote) in the repo at `cwd`. If `cwd` is not a
/// git repo, returns an empty list (no error) so the UI can hide the option.
///
/// Uses `git for-each-ref` (not `git branch`) because `git branch -z` is only
/// supported on git >= 2.41, while `for-each-ref` with a custom `--format` is
/// stable across versions and gives tab-separated fields for safe parsing.
#[tauri::command]
pub async fn git_branches(
	state: tauri::State<'_, BridgeState>,
	cwd: String,
) -> Result<Vec<GitBranchEntry>, String> {
	if let Some(value) =
		remote_fs_request(state.inner(), &cwd, "git_branches", serde_json::json!({})).await?
	{
		return serde_json::from_value(value)
			.map_err(|e| format!("Invalid remote git_branches response: {e}"));
	}
	// Cheap repo check — non-repo returns empty list, not an error.
	let inside = run_git_capture(&cwd, &["rev-parse", "--is-inside-work-tree"]);
	if !matches!(inside, Ok(s) if s.trim() == "true") {
		return Ok(Vec::new());
	}
	// %(HEAD) is "*" for the current branch, " " otherwise; %09 is a TAB so a
	// branch name containing a space can't corrupt the field split.
	let raw = run_git_capture(
		&cwd,
		&[
			"for-each-ref",
			"--format=%(HEAD)%09%(refname)%09%(upstream:short)",
			"refs/heads",
			"refs/remotes",
		],
	)?;
	Ok(parse_branches(&raw))
}

/// One entry from `git log` — a read-only snapshot for the Git tab's history view.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct GitLogEntry {
	/// Full commit hash.
	pub hash: String,
	/// Abbreviated hash (e.g. `4af2abd`).
	pub short: String,
	/// Author name.
	pub author: String,
	/// Author date in strict ISO 8601 (e.g. `2026-08-06T02:16:32+08:00`).
	pub date: String,
	/// Commit subject (first line of the message).
	pub subject: String,
	/// Refs pointing at this commit, comma-joined without the surrounding parens
	/// (e.g. `HEAD -> main, origin/main, tag: v1.0`). Empty if none.
	pub refs: String,
}

/// Parse `git log -z --format=%H\x1f%h\x1f%an\x1f%aI\x1f%s\x1f%d` into entries.
/// Records are NUL-separated; fields within a record are separated by US (\x1f).
/// The `%d` ref decoration comes through as " (...)" or empty -- we strip the
/// surrounding parens for cleaner display.
fn parse_log(raw: &str) -> Vec<GitLogEntry> {
	let mut entries = Vec::new();
	for record in raw.split('\0').filter(|r| !r.is_empty()) {
		let mut parts = record.splitn(6, '\x1f');
		let hash = parts.next().unwrap_or("").to_string();
		let short = parts.next().unwrap_or("").to_string();
		let author = parts.next().unwrap_or("").to_string();
		let date = parts.next().unwrap_or("").to_string();
		let subject = parts.next().unwrap_or("").to_string();
		let mut refs = parts.next().unwrap_or("").trim().to_string();
		if refs.starts_with('(') && refs.ends_with(')') {
			refs = refs[1..refs.len() - 1].trim().to_string();
		}
		if hash.is_empty() {
			continue;
		}
		entries.push(GitLogEntry {
			hash,
			short,
			author,
			date,
			subject,
			refs,
		});
	}
	entries
}

/// Return recent commits in the repo at `cwd`. Read-only — the Git tab never
/// mutates the repo; to commit/push/switch branches, ask the agent in chat so
/// the action lands in the event log. If `cwd` is not a git repo, returns an
/// empty list (no error) so the UI can hide the section. `limit` clamped 1..=200.
#[tauri::command]
pub async fn git_log(
	state: tauri::State<'_, BridgeState>,
	cwd: String,
	limit: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
	if let Some(value) = remote_fs_request(
		state.inner(),
		&cwd,
		"git_log",
		serde_json::json!({ "limit": limit }),
	)
	.await?
	{
		return serde_json::from_value(value)
			.map_err(|e| format!("Invalid remote git_log response: {e}"));
	}
	let inside = run_git_capture(&cwd, &["rev-parse", "--is-inside-work-tree"]);
	if !matches!(inside, Ok(s) if s.trim() == "true") {
		return Ok(Vec::new());
	}
	let n = limit.unwrap_or(100).clamp(1, 200);
	let n_str = n.to_string();
	// `%x1f` (US) separates fields within a record; `-z` NUL-separates records.
	// `%d` yields " (refs…)" or empty — we trim/unwrap the parens below.
	let raw = run_git_capture(
		&cwd,
		&[
			"log",
			"-z",
			"-n",
			&n_str,
			"--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%d",
		],
	)?;
	Ok(parse_log(&raw))
}

/// Return the unified diff a commit introduced (vs its first parent, or vs the
/// empty tree for the root commit via `--root`). Read-only — for inspecting
/// what landed in a commit from the Git tab's history view. `hash` may be any
/// hex prefix or refname the agent or user clicked.
#[tauri::command]
pub async fn git_show(
	state: tauri::State<'_, BridgeState>,
	cwd: String,
	hash: String,
) -> Result<String, String> {
	if let Some(value) = remote_fs_request(
		state.inner(),
		&cwd,
		"git_show",
		serde_json::json!({ "hash": hash }),
	)
	.await?
	{
		return serde_json::from_value(value)
			.map_err(|e| format!("Invalid remote git_show response: {e}"));
	}
	// Guard against option injection: a commit ref is hex (possibly with `/`,
	// `.`, `_`, `-` for refnames) and never starts with `-`.
	if hash.is_empty()
		|| hash.starts_with('-')
		|| hash.contains(|c: char| {
			!(c.is_ascii_alphanumeric() || c == '/' || c == '.' || c == '_' || c == '-')
		}) {
		return Err("invalid commit ref".into());
	}
	// `--no-commit-id` keeps the output a pure patch (no leading hash line).
	run_git_capture(
		&cwd,
		&[
			"diff-tree",
			"-p",
			"--no-color",
			"--root",
			"--no-commit-id",
			&hash,
		],
	)
}

/// Fetch the skills.sh leaderboard HTML page via Rust (bypasses CORS).
/// Returns the raw HTML so the frontend can parse skill links.
#[tauri::command]
pub async fn fetch_skills_sh() -> Result<String, String> {
	let client = reqwest::Client::builder()
		.user_agent("pizza-desktop/0.1")
		.timeout(Duration::from_secs(15))
		.build()
		.map_err(|e| format!("HTTP client error: {e}"))?;

	let res = client
		.get("https://www.skills.sh/")
		.send()
		.await
		.map_err(|e| format!("Fetch error: {e}"))?;

	if !res.status().is_success() {
		return Err(format!("skills.sh returned status {}", res.status()));
	}

	let html = res
		.text()
		.await
		.map_err(|e| format!("Read body error: {e}"))?;

	Ok(html)
}

/// Fetch a pi.dev packages catalog page via Rust (bypasses CORS).
/// `query` is the raw query string (e.g. "type=extension&sort=downloads&page=1").
#[tauri::command]
pub async fn fetch_pi_packages(query: String) -> Result<String, String> {
	let client = reqwest::Client::builder()
		.user_agent("pizza-desktop/0.1")
		.timeout(Duration::from_secs(15))
		.build()
		.map_err(|e| format!("HTTP client error: {e}"))?;

	let res = client
		.get(format!("https://pi.dev/packages?{query}"))
		.send()
		.await
		.map_err(|e| format!("Fetch error: {e}"))?;

	if !res.status().is_success() {
		return Err(format!("pi.dev returned status {}", res.status()));
	}

	let html = res
		.text()
		.await
		.map_err(|e| format!("Read body error: {e}"))?;

	Ok(html)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn normalizes_windows_paths_for_comparison() {
		let normalized = normalize_path_for_compare(r"C:\Users\Tom\.pizza\main");
		if cfg!(windows) {
			assert_eq!(normalized, "c:/users/tom/.pizza/main");
		} else {
			assert_eq!(normalized, "C:/Users/Tom/.pizza/main");
		}
	}

	#[test]
	fn gateway_command_strips_sidecar_mode() {
		let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
		assert_eq!(
			gateway_command(("pizza".into(), s(&["--mode", "rpc"]))),
			("pizza".to_string(), vec![])
		);
		assert_eq!(
			gateway_command((
				"node".into(),
				s(&["--loader", "l.mjs", "cli.js", "--mode", "rpc"])
			))
			.1,
			s(&["--loader", "l.mjs", "cli.js"])
		);
		// Anything else is passed through untouched.
		assert_eq!(
			gateway_command(("pizza".into(), s(&["--verbose"]))).1,
			s(&["--verbose"])
		);
	}

	#[test]
	fn gateway_requests_use_remote_path_instead_of_synthetic_workspace_key() {
		let state = BridgeState::default();
		lock_ok(&state.remote_workspaces).clear();
		assert_eq!(
			gateway_workspace_for_cwd(&state, "/Users/mac/project"),
			"/Users/mac/project"
		);

		let remote_key = "remote://abc123";
		lock_ok(&state.remote_workspaces).insert(
			remote_key.to_string(),
			remote::RemoteWorkspaceConfig {
				id: "abc123".to_string(),
				label: "Remote project".to_string(),
				ssh_target: "root@example.com".to_string(),
				port: None,
				identity_file: None,
				password: None,
				password_in_keychain: false,
				remote_path: "/root/kafka".to_string(),
				pizza_command: None,
				sync_credentials: true,
				created_at: 0,
				last_accessed_at: 0,
			},
		);
		assert_eq!(gateway_workspace_for_cwd(&state, remote_key), "/root/kafka");
	}

	#[test]
	fn same_remote_workspace_matches_host_port_and_directory_only() {
		let base = remote::RemoteWorkspaceConfig {
			id: "first".to_string(),
			label: "kafka".to_string(),
			ssh_target: "root@example.com".to_string(),
			port: None,
			identity_file: None,
			password: None,
			password_in_keychain: false,
			remote_path: "/root/kafka".to_string(),
			pizza_command: None,
			sync_credentials: true,
			created_at: 0,
			last_accessed_at: 0,
		};
		let mut equivalent = base.clone();
		equivalent.id = "second".to_string();
		equivalent.label = "different label".to_string();
		equivalent.port = Some(22);
		equivalent.password = Some("different credential".to_string());
		assert!(same_remote_workspace(&base, &equivalent));

		let mut different_path = equivalent.clone();
		different_path.remote_path = "/root/kafka/tests".to_string();
		assert!(!same_remote_workspace(&base, &different_path));

		let mut different_port = equivalent;
		different_port.port = Some(2222);
		assert!(!same_remote_workspace(&base, &different_port));
	}

	#[test]
	fn resolve_shell_path_never_empty() {
		// Always returns something (login-shell PATH or a fallback to env PATH).
		let path = resolve_shell_path();
		assert!(
			!path.is_empty(),
			"resolve_shell_path must return a non-empty PATH"
		);
	}

	#[test]
	fn run_shell_capture_path_is_clean() {
		// When captured, the PATH must be a single line with no surrounding
		// whitespace (the printf %s form guarantees no trailing newline).
		if let Some(path) = run_shell_capture_path("/bin/zsh") {
			assert!(
				!path.contains('\n'),
				"captured PATH must not contain newlines: {path:?}"
			);
			assert_eq!(path, path.trim(), "captured PATH must be trimmed: {path:?}");
		}
	}

	#[test]
	fn parse_numstat_reads_counts_and_renames() {
		// Plain entries are "adds\tdels\tpath"; renames leave the path field
		// empty and follow with <old>\0<new>.
		let raw = "3\t1\tsrc/a.ts\0-\t-\tassets/logo.png\0".to_string()
			+ "5\t2\t\0src/old.ts\0src/new.ts\0";
		let map = parse_numstat(&raw);
		assert_eq!(map.get("src/a.ts"), Some(&(3, 1)));
		// Binary files report "-" and are skipped.
		assert_eq!(map.get("assets/logo.png"), None);
		// A rename is keyed on the NEW path so it matches the porcelain record.
		assert_eq!(map.get("src/new.ts"), Some(&(5, 2)));
		assert_eq!(map.get("src/old.ts"), None);
	}

	#[test]
	fn parse_porcelain_pairs_renames_with_original_path() {
		let stats = HashMap::from([("src/new.ts".to_string(), (5u32, 2u32))]);
		// "R  <new>\0<old>" — the original path is a separate NUL field, so a
		// naive split would mistake it for another record.
		let raw = " M src/a.ts\0R  src/new.ts\0src/old.ts\0?? notes.md\0";
		let entries = parse_porcelain(raw, &stats);
		assert_eq!(
			entries.len(),
			3,
			"the rename's old path must not become an entry"
		);

		assert_eq!(entries[0].xy, " M");
		assert_eq!(entries[0].path, "src/a.ts");
		assert_eq!(entries[0].orig_path, None);
		// No numstat entry for this path -> no counts.
		assert_eq!(entries[0].additions, None);

		assert_eq!(entries[1].xy, "R ");
		assert_eq!(entries[1].path, "src/new.ts");
		assert_eq!(entries[1].orig_path.as_deref(), Some("src/old.ts"));
		assert_eq!(entries[1].additions, Some(5));
		assert_eq!(entries[1].deletions, Some(2));

		assert_eq!(entries[2].xy, "??");
		assert_eq!(entries[2].path, "notes.md");
	}

	#[test]
	fn parse_porcelain_handles_empty_output() {
		assert!(parse_porcelain("", &HashMap::new()).is_empty());
	}

	#[test]
	fn parse_log_reads_fields_and_strips_ref_parens() {
		// Two NUL-separated records; fields split on US (\x1f). The first carries
		// a %d decoration of " (HEAD -> main, tag: v1.0)", the second none.
		let raw = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\x1fdeadbeef\x1fAda\x1f2026-08-06T02:16:32+08:00\x1finit\x1f (HEAD -> main, tag: v1.0)\0cafebabecafebabecafebabecafebabecafebabe\x1fcafebabe\x1fBob\x1f2026-08-07T10:00:00Z\x1ffix: oops\x1f\0";
		let entries = parse_log(&raw);
		assert_eq!(entries.len(), 2);
		assert_eq!(entries[0].short, "deadbeef");
		assert_eq!(entries[0].subject, "init");
		assert_eq!(entries[0].author, "Ada");
		// Parens stripped from the ref decoration.
		assert_eq!(entries[0].refs, "HEAD -> main, tag: v1.0");
		// Empty %d yields an empty refs string, not garbage.
		assert_eq!(entries[1].refs, "");
		assert_eq!(entries[1].subject, "fix: oops");
	}

	#[test]
	fn parse_branches_splits_locals_remotes_and_skips_symbolic_head() {
		// One ref per line, TAB-separated. "*" marks the current branch; refs/remotes/
		//origin/HEAD is a symbolic ref that must be dropped, not listed.
		let raw = "*\trefs/heads/main\torigin/main\n \trefs/heads/feature/x\t\n\trefs/remotes/origin/main\t\n\trefs/remotes/origin/HEAD\t\n";
		let b = parse_branches(&raw);
		assert_eq!(b.len(), 3, "the symbolic origin/HEAD must be skipped");
		assert_eq!(b[0].name, "main");
		assert!(b[0].is_current);
		assert!(!b[0].is_remote);
		assert_eq!(b[0].upstream.as_deref(), Some("origin/main"));
		// A local branch with a slash in its name stays local (no upstream).
		assert_eq!(b[1].name, "feature/x");
		assert!(!b[1].is_remote);
		assert_eq!(b[1].upstream, None);
		// Remote-tracking branch, no leading refs/ in the display name.
		assert_eq!(b[2].name, "origin/main");
		assert!(b[2].is_remote);
	}
}

// ============================================================================
// OAuth login (Sign in with an account)
//
// Runs `pizza auth login --provider X --mode jsonl` and forwards its JSONL
// lines to the window as `auth_login_event`. The frontend answers prompts by
// invoking `oauth_login_answer` with the entered string.
// ============================================================================

/// Start an OAuth account login. Fails if another login is already running.
#[tauri::command]
pub async fn oauth_login(
	app: AppHandle,
	state: tauri::State<'_, BridgeState>,
	provider: String,
) -> Result<(), String> {
	{
		let mut guard = state.oauth_login.lock().unwrap();
		if let Some(existing) = guard.as_mut() {
			// Try to reap a finished previous login so a fresh one can start.
			match existing.child.try_wait() {
				Ok(Some(_)) => *guard = None,
				_ => return Err("A login is already in progress".into()),
			}
		}
	}

	let (program, mut base_args) = resolve_pizza_command_binary(&app);
	// resolve_pizza_command appends --mode rpc for the agent sidecar; strip it
	// and use the auth subcommand instead.
	base_args.retain(|a| a != "rpc" && a != "--mode");
	let mut cmd = std::process::Command::new(&program);
	cmd.args(base_args)
		.args(["auth", "login", "--provider", &provider, "--mode", "jsonl"])
		.stdin(std::process::Stdio::piped())
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::null());

	let mut child = cmd
		.spawn()
		.map_err(|e| format!("failed to spawn pizza: {e}"))?;
	let stdin = child.stdin.take().ok_or("no stdin on login child")?;
	let stdout = child.stdout.take().ok_or("no stdout on login child")?;

	*state.oauth_login.lock().unwrap() = Some(OAuthLoginChild { child, stdin });

	std::thread::spawn(move || {
		use std::io::BufRead;
		let reader = std::io::BufReader::new(stdout);
		let mut ok_done = false;
		for line in reader.lines() {
			let Ok(line) = line else { break };
			let parsed: Option<serde_json::Value> = serde_json::from_str(&line).ok();
			if let Some(value) = parsed {
				let done = value.get("type").and_then(|t| t.as_str()) == Some("done");
				if done && value.get("ok").and_then(|v| v.as_bool()) == Some(true) {
					ok_done = true;
				}
				let _ = app.emit("auth_login_event", value);
				if done {
					break;
				}
			}
		}
		// A successful login rewrote auth.json, which sidecars keep cached in
		// memory — fan out reload_providers like set_provider_api_key does, or
		// the new credential stays invisible until the next app restart.
		if ok_done {
			if let Some(state) = app.try_state::<BridgeState>() {
				broadcast_to_all_sidecars(state.inner(), "reload_providers");
			}
			let channel_app = app.clone();
			tauri::async_runtime::spawn(async move {
				if let Some(state) = channel_app.try_state::<BridgeState>() {
					broadcast_to_all_channels(state.inner(), "reload_providers").await;
				}
			});
			schedule_remote_provider_provisioning(&app, Duration::ZERO);
		}
		// Ensure the child is reaped and the slot freed.
		if let Some(state) = app.try_state::<BridgeState>() {
			if let Ok(mut guard) = state.oauth_login.lock() {
				*guard = None;
			}
		}
	});

	Ok(())
}

/// Answer the current login prompt (writes one JSONL answer line to stdin).
#[tauri::command]
pub async fn oauth_login_answer(
	state: tauri::State<'_, BridgeState>,
	answer: String,
) -> Result<(), String> {
	let mut guard = state.oauth_login.lock().unwrap();
	let child = guard.as_mut().ok_or("no login in progress")?;
	use std::io::Write;
	let line = serde_json::json!({ "answer": answer }).to_string();
	writeln!(child.stdin, "{line}").map_err(|e| format!("failed to write answer: {e}"))
}

/// Abort the current login, if any.
#[tauri::command]
pub async fn oauth_login_cancel(state: tauri::State<'_, BridgeState>) -> Result<(), String> {
	let mut guard = state.oauth_login.lock().unwrap();
	if let Some(child) = guard.as_mut() {
		let _ = child.child.kill();
	}
	*guard = None;
	Ok(())
}

/// Resolve just the pizza binary + base args (no --mode rpc suffix).
fn resolve_pizza_command_binary(app: &AppHandle) -> (String, Vec<String>) {
	let (program, args) = resolve_pizza_command(app);
	(program, args)
}

/// Login option entries for the GUI ("Sign in with an account" / "API key").
#[derive(Serialize, Clone)]
pub struct AuthLoginOption {
	pub id: String,
	pub name: String,
	pub kind: String, // "account" | "apiKey"
}

fn run_auth_list(app: &AppHandle) -> Result<Vec<AuthLoginOption>, String> {
	let (program, mut base_args) = resolve_pizza_command_binary(app);
	base_args.retain(|a| a != "rpc" && a != "--mode");
	let output = std::process::Command::new(&program)
		.args(base_args)
		.args(["auth", "list", "--json"])
		.stderr(std::process::Stdio::null())
		.output()
		.map_err(|e| format!("failed to spawn pizza: {e}"))?;
	let stdout = String::from_utf8_lossy(&output.stdout);
	let parsed: serde_json::Value =
		serde_json::from_str(stdout.trim()).map_err(|e| format!("bad auth list output: {e}"))?;
	let mut options = Vec::new();
	for key in ["account", "apiKey"] {
		if let Some(entries) = parsed.get(key).and_then(|v| v.as_array()) {
			for entry in entries {
				let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or_default();
				let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or(id);
				if !id.is_empty() {
					options.push(AuthLoginOption {
						id: id.to_string(),
						name: name.to_string(),
						kind: key.to_string(),
					});
				}
			}
		}
	}
	Ok(options)
}

/// `pizza auth list --json` — both login categories. Served from the
/// session cache when warm (see `warm_auth_options`).
#[tauri::command]
pub async fn list_auth_options(
	app: AppHandle,
	state: tauri::State<'_, BridgeState>,
) -> Result<Vec<AuthLoginOption>, String> {
	if let Some(cached) = state.auth_options_cache.lock().unwrap().clone() {
		return Ok(cached);
	}
	let options = run_auth_list(&app)?;
	*state.auth_options_cache.lock().unwrap() = Some(options.clone());
	Ok(options)
}

/// Warm the auth-options cache in the background at app startup so the first
/// Settings open doesn't wait on a pizza CLI spawn.
pub(crate) fn warm_auth_options(app: &AppHandle) {
	if app
		.state::<BridgeState>()
		.auth_options_cache
		.lock()
		.unwrap()
		.is_some()
	{
		return;
	}
	if let Ok(options) = run_auth_list(app) {
		*app.state::<BridgeState>()
			.auth_options_cache
			.lock()
			.unwrap() = Some(options);
	}
}

// ─── App update check ───────────────────────────────────────────────────────
//
// The desktop app is distributed via GitHub release installers
// (Pizza_<version>_<platform>_<arch>.<ext>). There is no in-app self-update
// (the installers are not updater-signed), so "update" means: detect a newer
// release and point the user at the download page / platform asset.

/// Result of a desktop update check. Always succeeds — a failed network probe
/// is reported through `error` so the UI can show a friendly message instead
/// of an error dialog.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
	/// Version of the running app (from tauri.conf.json).
	pub current_version: String,
	/// Latest published release version, when the registry was reachable.
	pub latest_version: Option<String>,
	pub update_available: bool,
	/// Browser URL of the latest release page.
	pub release_url: String,
	/// Direct download URL for the platform installer, when one exists.
	pub download_url: Option<String>,
	/// When the latest release was published (ISO 8601).
	pub published_at: Option<String>,
	/// Network/parse error, if any.
	pub error: Option<String>,
}

/// Parse a `x.y.z` version tag (with optional leading `v`) into numbers.
/// Returns None when the tag isn't a plain semver triple.
fn parse_version_tag(tag: &str) -> Option<(u64, u64, u64)> {
	let cleaned = tag.trim().trim_start_matches('v');
	let mut parts = cleaned.split('.');
	let major = parts.next()?.parse().ok()?;
	let minor = parts.next()?.parse().ok()?;
	let patch = parts.next()?.parse().ok()?;
	if parts.next().is_some() {
		return None;
	}
	Some((major, minor, patch))
}

/// Compare two semver triples: -1 / 0 / 1.
fn compare_versions(a: (u64, u64, u64), b: (u64, u64, u64)) -> i32 {
	if a.0 != b.0 {
		return if a.0 > b.0 { 1 } else { -1 };
	}
	if a.1 != b.1 {
		return if a.1 > b.1 { 1 } else { -1 };
	}
	if a.2 != b.2 {
		return if a.2 > b.2 { 1 } else { -1 };
	}
	0
}

/// Pick the installer asset for the current platform from the release's asset
/// list, following the `Pizza_<version>_<platform>_<arch>.<ext>` naming scheme
/// produced by the desktop release workflow.
fn pick_platform_asset(asset_urls: &[String]) -> Option<String> {
	let (os, arch): (&str, &str) = if cfg!(target_os = "macos") {
		(
			"macos",
			if cfg!(target_arch = "aarch64") {
				"arm64"
			} else {
				"x64"
			},
		)
	} else if cfg!(target_os = "windows") {
		("windows", "x64")
	} else {
		("linux", "x64")
	};
	let platform = format!("_{os}_{arch}");
	// Preference order per platform: dmg / nsis setup / deb. msi and rpm are
	// kept as fallbacks for users on those ecosystems.
	let suffixes: &[&str] = if cfg!(target_os = "macos") {
		&[".dmg"]
	} else if cfg!(target_os = "windows") {
		&["-setup.exe", ".exe", ".msi"]
	} else {
		&[".deb", ".rpm", ".AppImage"]
	};
	for suffix in suffixes {
		if let Some(url) = asset_urls
			.iter()
			.find(|u| u.contains(&platform) && u.ends_with(suffix))
		{
			return Some(url.clone());
		}
	}
	None
}

const GITHUB_LATEST_RELEASE_API: &str =
	"https://api.github.com/repos/pizza-agent/pizza/releases/latest";
const GITHUB_RELEASES_PAGE: &str = "https://github.com/pizza-agent/pizza/releases/latest";

/// Check GitHub releases for a newer desktop app version. Never fails hard —
/// network problems come back as `AppUpdateInfo.error` so the caller can
/// render them inline.
#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<AppUpdateInfo, String> {
	let current_version = app.package_info().version.to_string();

	let client = reqwest::Client::builder()
		.user_agent(format!("pizza-desktop/{current_version}"))
		.timeout(Duration::from_secs(8))
		.build()
		.map_err(|e| format!("HTTP client error: {e}"))?;

	let res = match client
		.get(GITHUB_LATEST_RELEASE_API)
		.header("Accept", "application/json")
		.send()
		.await
	{
		Ok(res) => res,
		Err(e) => {
			return Ok(AppUpdateInfo {
				current_version,
				latest_version: None,
				update_available: false,
				release_url: GITHUB_RELEASES_PAGE.to_string(),
				download_url: None,
				published_at: None,
				error: Some(format!("network error: {e}")),
			});
		}
	};

	if !res.status().is_success() {
		return Ok(AppUpdateInfo {
			current_version,
			latest_version: None,
			update_available: false,
			release_url: GITHUB_RELEASES_PAGE.to_string(),
			download_url: None,
			published_at: None,
			error: Some(format!("GitHub returned status {}", res.status())),
		});
	}

	let body: serde_json::Value = match res.json().await {
		Ok(v) => v,
		Err(e) => {
			return Ok(AppUpdateInfo {
				current_version,
				latest_version: None,
				update_available: false,
				release_url: GITHUB_RELEASES_PAGE.to_string(),
				download_url: None,
				published_at: None,
				error: Some(format!("bad JSON: {e}")),
			});
		}
	};

	let tag = body
		.get("tag_name")
		.and_then(|v| v.as_str())
		.unwrap_or_default()
		.to_string();
	if tag.is_empty() {
		return Ok(AppUpdateInfo {
			current_version,
			latest_version: None,
			update_available: false,
			release_url: GITHUB_RELEASES_PAGE.to_string(),
			download_url: None,
			published_at: None,
			error: Some("release has no tag_name".to_string()),
		});
	}

	let release_url = body
		.get("html_url")
		.and_then(|v| v.as_str())
		.unwrap_or(GITHUB_RELEASES_PAGE)
		.to_string();
	let published_at = body
		.get("published_at")
		.and_then(|v| v.as_str())
		.map(|s| s.to_string());
	let asset_urls: Vec<String> = body
		.get("assets")
		.and_then(|v| v.as_array())
		.map(|assets| {
			assets
				.iter()
				.filter_map(|a| {
					a.get("browser_download_url")
						.and_then(|v| v.as_str())
						.map(|s| s.to_string())
				})
				.collect()
		})
		.unwrap_or_default();

	let latest_version = tag.trim_start_matches('v').to_string();
	let update_available = match (parse_version_tag(&tag), parse_version_tag(&current_version)) {
		(Some(latest), Some(current)) => compare_versions(latest, current) > 0,
		// Unparseable versions: fall back to a plain inequality so a surprise
		// tag format still surfaces an update.
		_ => latest_version != current_version,
	};

	Ok(AppUpdateInfo {
		current_version,
		latest_version: Some(latest_version),
		update_available,
		release_url,
		download_url: pick_platform_asset(&asset_urls),
		published_at,
		error: None,
	})
}
