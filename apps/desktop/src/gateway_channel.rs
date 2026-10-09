//! Gateway channel client (Rust mirror of packages/gateway/channel-client.ts).
//!
//! Connects to the gateway's Unix socket and speaks the Layer-1 channel
//! protocol: attach to a workspace, forward Layer-0 RPC commands (response
//! correlated by id), enumerate workspaces, and receive the agent's event
//! stream. This is the building block for migrating the desktop bridge from
//! "spawn a sidecar per cwd" to "one gateway-owned agent, many channels".
//!
//! Kept self-contained (std::net + a reader thread, mirroring bridge.rs's
//! sidecar reader pattern) so it can be wired behind a new Tauri command
//! without touching the existing spawn path.
//!
//! NOTE: this module is the foundation; the live init_sidecar/rpc_command
//! rewrite + GUI smoke test is a separate step (see ADR in the PR thread).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

/// Combined `Read + Write` so a single trait object can carry both halves
/// (Rust forbids `dyn Read + Write` — only one non-auto trait per object).
trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

/// Default gateway socket path. On Unix: `~/.pizza/gateway.sock`. On Windows:
/// the named pipe `\\.\pipe\gateway` (mirrors the TS `gatewaySocketPath`).
pub fn gateway_socket_path() -> Option<PathBuf> {
	#[cfg(unix)]
	{
		let home = std::env::var("HOME").ok()?;
		Some(PathBuf::from(home).join(".pizza").join("gateway.sock"))
	}
	#[cfg(windows)]
	{
		Some(PathBuf::from(r"\\.\pipe\gateway"))
	}
	#[cfg(not(any(unix, windows)))]
	{
		None
	}
}

/// One message delivered to the caller: either an id-routed RPC response, or
/// a fanned-out event for a workspace.
#[derive(Debug, Clone)]
pub enum ChannelMessage {
	/// A response to a command we sent (correlated by id).
	#[allow(dead_code)]
	Response { id: String, frame: Value },
	/// A fanned-out event from a workspace's agent.
	#[allow(dead_code)]
	Event {
		#[allow(dead_code)]
		workspace: String,
		frame: Value,
	},
	/// A list_result (response to list()).
	ListResult {
		#[allow(dead_code)]
		workspaces: Value,
	},
	/// An attach confirmation (carries the resolved cwd).
	AttachOk { workspace: String },
	/// A gateway-level error.
	Error(String),
	/// The reader thread hit EOF / the connection closed.
	Disconnected,
}

type PendingMap = Arc<Mutex<HashMap<String, Arc<Mutex<Option<Value>>>>>>;

/// Upper bound for a single channel write. A write only blocks when the
/// gateway stops draining its end of the socket/pipe; past this the
/// connection is considered dead instead of wedging the caller forever.
const WRITE_TIMEOUT: Duration = Duration::from_secs(15);

/// A channel connection to the gateway. Cheap to clone — the underlying socket
/// and reader thread are shared via Arc. Each clone is the same connection;
/// use one per desktop process (the gateway multiplexes many workspaces).
#[derive(Clone)]
pub struct GatewayChannel {
	write: Arc<Mutex<Box<dyn Write + Send>>>,
	pending: PendingMap,
	/// Inbox for non-response messages (events, attach_ok, list_result, error).
	inbox: Arc<Mutex<Vec<ChannelMessage>>>,
	/// False once the reader hit EOF or the connection was closed/corrupted.
	alive: Arc<AtomicBool>,
	/// Tears the connection down so the blocked reader thread exits (and the
	/// gateway sees the disconnect) instead of leaking a zombie subscriber.
	closer: Arc<dyn Fn() + Send + Sync>,
}

impl GatewayChannel {
	/// Connect to the gateway socket/pipe. Spawns a background reader thread
	/// that parses JSONL and dispatches responses (by id) to pending waiters
	/// and everything else into the shared inbox.
	#[cfg(unix)]
	pub fn connect(socket_path: &PathBuf) -> Result<Self, String> {
		let stream = UnixStream::connect(socket_path).map_err(|e| {
			format!(
				"Failed to connect to gateway at {}: {}",
				socket_path.display(),
				e
			)
		})?;
		stream
			.set_nonblocking(false)
			.map_err(|e| format!("set_nonblocking failed: {e}"))?;
		stream
			.set_write_timeout(Some(WRITE_TIMEOUT))
			.map_err(|e| format!("set_write_timeout failed: {e}"))?;
		let write_stream = stream
			.try_clone()
			.map_err(|e| format!("clone stream: {e}"))?;
		let close_stream = stream
			.try_clone()
			.map_err(|e| format!("clone stream: {e}"))?;
		let write: Box<dyn Write + Send> = Box::new(write_stream);
		Self::from_streams(
			stream,
			write,
			Arc::new(move || {
				let _ = close_stream.shutdown(std::net::Shutdown::Both);
			}),
		)
	}

	/// Connect to the gateway named pipe (Windows). The pipe is opened for
	/// OVERLAPPED I/O (see `win_pipe`): with a synchronous handle Windows
	/// serializes every read and write on the shared file object, so the
	/// reader thread's pending `ReadFile` would block each `WriteFile` until
	/// the gateway sent something — a deadlock right after attach.
	#[cfg(windows)]
	pub fn connect(socket_path: &PathBuf) -> Result<Self, String> {
		let pipe_name = socket_path.to_string_lossy().to_string();
		let pipe = win_pipe::PipeStream::connect(&pipe_name, None, Some(WRITE_TIMEOUT))?;
		let write: Box<dyn Write + Send> = Box::new(pipe.clone());
		let closer = pipe.clone();
		Self::from_streams(pipe, write, Arc::new(move || closer.close()))
	}

	/// Build a channel from its read + write halves and spawn the shared
	/// reader thread. Platform-specific `connect` impls produce the halves;
	/// everything from here on (JSONL parsing, id-routed dispatch, EOF
	/// handling) is identical across Unix sockets and Windows named pipes.
	fn from_streams<R: Read + Send + 'static>(
		read: R,
		write: Box<dyn Write + Send>,
		closer: Arc<dyn Fn() + Send + Sync>,
	) -> Result<Self, String> {
		let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
		let inbox: Arc<Mutex<Vec<ChannelMessage>>> = Arc::new(Mutex::new(Vec::new()));
		let alive = Arc::new(AtomicBool::new(true));

		let reader_pending = Arc::clone(&pending);
		let reader_inbox = Arc::clone(&inbox);
		let reader_alive = Arc::clone(&alive);
		thread::spawn(move || {
			let reader = BufReader::new(read);
			for line in reader.lines() {
				match line {
					Ok(line) => {
						let trimmed = line.trim();
						if trimmed.is_empty() || !trimmed.starts_with('{') {
							continue;
						}
						let parsed: Value = match serde_json::from_str(trimmed) {
							Ok(v) => v,
							Err(_) => continue,
						};
						Self::dispatch(&parsed, &reader_pending, &reader_inbox);
					}
					Err(_) => {
						break;
					}
				}
			}
			// EOF: notify + release any waiters so they don't hang forever.
			reader_alive.store(false, Ordering::SeqCst);
			reader_inbox
				.lock()
				.unwrap()
				.push(ChannelMessage::Disconnected);
			for (_, slot) in reader_pending.lock().unwrap().drain() {
				if let Ok(mut guard) = slot.lock() {
					if guard.is_none() {
						*guard = Some(json!({ "_disconnected": true }));
					}
				}
			}
		});

		Ok(Self {
			write: Arc::new(Mutex::new(write)),
			pending,
			inbox,
			alive,
			closer,
		})
	}

	/// False once the connection is gone (EOF, closed, or a failed write left
	/// the JSONL framing in an unknown state). Callers must not reuse it.
	pub fn is_alive(&self) -> bool {
		self.alive.load(Ordering::SeqCst)
	}

	/// Close the connection. The reader thread then hits EOF/error, pushes
	/// `Disconnected` and releases pending waiters, so the bridge's normal
	/// disconnect path (evict + `sidecar_exit`) takes over.
	pub fn close(&self) {
		self.alive.store(false, Ordering::SeqCst);
		(self.closer)();
	}

	/// Route one parsed gateway message to its waiter (response) or the inbox.
	fn dispatch(parsed: &Value, pending: &PendingMap, inbox: &Arc<Mutex<Vec<ChannelMessage>>>) {
		let etype = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
		match etype {
			"rpc" => {
				let workspace = parsed
					.get("workspace")
					.and_then(|w| w.as_str())
					.unwrap_or("")
					.to_string();
				let frame = parsed.get("frame").cloned().unwrap_or(Value::Null);
				let id = frame
					.get("id")
					.and_then(|i| i.as_str())
					.map(|s| s.to_string());
				if let Some(id) = id {
					if let Some(slot) = pending.lock().unwrap().get(&id).cloned() {
						if let Ok(mut guard) = slot.lock() {
							*guard = Some(frame.clone());
						}
						return;
					}
				}
				// Not a pending response → it's a fanned-out event.
				inbox
					.lock()
					.unwrap()
					.push(ChannelMessage::Event { workspace, frame });
			}
			"attach_ok" => {
				let workspace = parsed
					.get("workspace")
					.and_then(|w| w.as_str())
					.unwrap_or("")
					.to_string();
				inbox
					.lock()
					.unwrap()
					.push(ChannelMessage::AttachOk { workspace });
			}
			"list_result" => {
				let workspaces = parsed
					.get("workspaces")
					.cloned()
					.unwrap_or(Value::Array(vec![]));
				inbox
					.lock()
					.unwrap()
					.push(ChannelMessage::ListResult { workspaces });
			}
			"channel_op_result" => {
				// Channel-management replies are id-routed like rpc responses,
				// except the id sits at the envelope's top level (not in a frame).
				let id = parsed
					.get("id")
					.and_then(|i| i.as_str())
					.map(|s| s.to_string());
				if let Some(id) = id {
					if let Some(slot) = pending.lock().unwrap().get(&id).cloned() {
						if let Ok(mut guard) = slot.lock() {
							*guard = Some(parsed.clone());
						}
						return;
					}
				}
			}
			"error" => {
				let message = parsed
					.get("message")
					.and_then(|m| m.as_str())
					.unwrap_or("gateway error")
					.to_string();
				inbox.lock().unwrap().push(ChannelMessage::Error(message));
			}
			_ => {}
		}
	}

	fn write_line(&self, obj: &Value) -> Result<(), String> {
		if !self.is_alive() {
			return Err("gateway connection closed".into());
		}
		let mut line = serde_json::to_string(obj).map_err(|e| e.to_string())?;
		line.push('\n');
		let mut stream = self.write.lock().map_err(|e| e.to_string())?;
		let result = stream
			.write_all(line.as_bytes())
			.and_then(|_| stream.flush());
		drop(stream);
		if let Err(e) = result {
			// A failed/timed-out write may have sent a partial line, so the
			// stream framing is unrecoverable: kill the connection.
			self.close();
			return Err(format!("gateway write failed: {e}"));
		}
		Ok(())
	}

	/// Attach to a workspace's event stream. Returns the resolved cwd.
	pub fn attach(&self, workspace: &str) -> Result<String, String> {
		self.write_line(&json!({ "type": "attach", "workspace": workspace }))?;
		self.wait_inbox(|msg| {
			matches!(
				msg,
				ChannelMessage::AttachOk { .. } | ChannelMessage::Error(_)
			)
		})
		.and_then(|msg| match msg {
			ChannelMessage::AttachOk { workspace } => Ok(workspace),
			ChannelMessage::Error(e) => Err(e),
			_ => Err("unexpected message".into()),
		})
	}

	/// Forward a Layer-0 RPC command to a workspace's agent and await the
	/// response (correlated by the command's id).
	pub fn rpc(&self, workspace: &str, frame: Value) -> Result<Value, String> {
		let id = frame
			.get("id")
			.and_then(|i| i.as_str())
			.ok_or_else(|| "rpc frame requires a string id".to_string())?
			.to_string();
		let slot: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
		self.pending
			.lock()
			.unwrap()
			.insert(id.clone(), Arc::clone(&slot));
		// The deadline covers the write too (bounded by WRITE_TIMEOUT).
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
		if let Err(e) =
			self.write_line(&json!({ "type": "rpc", "workspace": workspace, "frame": frame }))
		{
			self.pending.lock().unwrap().remove(&id);
			return Err(e);
		}
		// Spin-wait on the slot. The reader thread fills it (or a disconnect
		// sentinel). Matches the blocking nature of the sidecar reader path.
		loop {
			if let Some(value) = slot.lock().unwrap().take() {
				self.pending.lock().unwrap().remove(&id);
				if value.get("_disconnected").is_some() {
					return Err("gateway connection closed".into());
				}
				return Ok(value);
			}
			if std::time::Instant::now() > deadline {
				self.pending.lock().unwrap().remove(&id);
				return Err("rpc timed out waiting for response".into());
			}
			std::thread::sleep(std::time::Duration::from_millis(5));
		}
	}

	/// Enumerate known workspaces.
	#[allow(dead_code)]
	pub fn list(&self) -> Result<Value, String> {
		self.write_line(&json!({ "type": "list" }))?;
		self.wait_inbox(|msg| {
			matches!(
				msg,
				ChannelMessage::ListResult { .. } | ChannelMessage::Error(_)
			)
		})
		.and_then(|msg| match msg {
			ChannelMessage::ListResult { workspaces } => Ok(workspaces),
			ChannelMessage::Error(e) => Err(e),
			_ => Err("unexpected message".into()),
		})
	}

	/// Stop receiving events for a workspace on this connection.
	#[allow(dead_code)]
	pub fn detach(&self, workspace: &str) -> Result<(), String> {
		self.write_line(&json!({ "type": "detach", "workspace": workspace }))
	}

	/// Send a channel-management op (list/save/delete/set_enabled/test) and
	/// await the matching `channel_op_result`. Returns the `data` payload on
	/// `ok`, or the gateway's error string otherwise.
	pub fn channel_op(&self, request: Value) -> Result<Value, String> {
		let mut obj = request
			.as_object()
			.cloned()
			.ok_or_else(|| "channel_op request must be an object".to_string())?;
		let id = obj
			.get("id")
			.and_then(|i| i.as_str())
			.map(|s| s.to_string())
			.unwrap_or_else(|| format!("cop_{}", uuid::Uuid::new_v4()));
		obj.insert("type".to_string(), Value::String("channel_op".to_string()));
		obj.insert("id".to_string(), Value::String(id.clone()));
		let slot: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
		self.pending
			.lock()
			.unwrap()
			.insert(id.clone(), Arc::clone(&slot));
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
		if let Err(e) = self.write_line(&Value::Object(obj)) {
			self.pending.lock().unwrap().remove(&id);
			return Err(e);
		}
		loop {
			if let Some(value) = slot.lock().unwrap().take() {
				self.pending.lock().unwrap().remove(&id);
				if value.get("_disconnected").is_some() {
					return Err("gateway connection closed".into());
				}
				if value.get("ok").and_then(|v| v.as_bool()) == Some(true) {
					return Ok(value.get("data").cloned().unwrap_or(Value::Null));
				}
				let err = value
					.get("error")
					.and_then(|e| e.as_str())
					.unwrap_or("channel op failed")
					.to_string();
				return Err(err);
			}
			if std::time::Instant::now() > deadline {
				self.pending.lock().unwrap().remove(&id);
				return Err("channel op timed out".into());
			}
			std::thread::sleep(std::time::Duration::from_millis(5));
		}
	}

	/// Drain only fanned-out **events** and the disconnect sentinel from the
	/// inbox. Control messages (AttachOk / ListResult / Error) are left in
	/// place so a concurrent `attach()`/`list()` via `wait_inbox` doesn't lose
	/// its reply to the drainer. Disconnect is also returned so the caller can
	/// detect a dead connection.
	pub fn drain_events(&self) -> Vec<ChannelMessage> {
		let mut inbox = self.inbox.lock().unwrap();
		let (events, rest): (Vec<ChannelMessage>, Vec<ChannelMessage>) =
			inbox.drain(..).partition(|m| {
				matches!(
					m,
					ChannelMessage::Event { .. } | ChannelMessage::Disconnected
				)
			});
		// Put control messages back so wait_inbox can still see them.
		inbox.extend(rest);
		events
	}

	/// Block until an inbox message matches `pred`, then return it.
	fn wait_inbox<F>(&self, pred: F) -> Result<ChannelMessage, String>
	where
		F: Fn(&ChannelMessage) -> bool,
	{
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
		loop {
			let mut inbox = self.inbox.lock().unwrap();
			if let Some(pos) = inbox.iter().position(|m| pred(m)) {
				return Ok(inbox.remove(pos));
			}
			drop(inbox);
			if std::time::Instant::now() > deadline {
				return Err("timed out waiting for gateway response".into());
			}
			std::thread::sleep(std::time::Duration::from_millis(5));
		}
	}
}

/// Spawn (or reuse) the gateway daemon: `pizza --mode gateway`. Detached, like
/// the TS ensureGateway. Returns once the socket/pipe responds to a ping.
///
/// If `expected_version` is provided and a gateway is already running, its
/// reported version is compared: a mismatch (e.g. the user just upgraded and
/// the old daemon is still alive) triggers a graceful shutdown + fresh spawn
/// so upgrading requires no manual `pizza gateway restart`. Busy agents are
/// given up to 30s to finish their turn before the shutdown is sent.
pub fn ensure_gateway(
	socket_path: &PathBuf,
	pizza_cmd: (&str, &[String]),
	expected_version: Option<&str>,
) -> Result<(), String> {
	use std::process::{Command, Stdio};
	// Fast path: ping an existing gateway.
	if gateway_ready(socket_path) {
		// Version check: if the caller knows its version and the running
		// gateway reports a different one, it's a stale daemon from before
		// an upgrade — replace it.
		if let Some(expected) = expected_version {
			if let Some(status) = query_gateway_status(socket_path) {
				if status.version != expected {
					// Wait for busy agents to finish so we don't kill a mid-turn task.
					let drain_deadline =
						std::time::Instant::now() + std::time::Duration::from_secs(30);
					while status_has_busy_agents(&status)
						&& std::time::Instant::now() < drain_deadline
					{
						std::thread::sleep(std::time::Duration::from_secs(1));
					}
					if status_has_busy_agents(&status) {
						// Agents are STILL busy after the drain window.
						// Replacing the gateway now would kill mid-turn tasks;
						// keep the older daemon instead. Version skew is
						// harmless — the channel protocol is version-tolerant
						// and the next idle start will upgrade it.
						return Ok(());
					}
					// Graceful shutdown. If the gateway refuses to die, REUSE
					// it — force-unlinking a live gateway's socket orphans the
					// daemon (and its pooled agents) while a fresh gateway
					// spawns besides it; duplicate gateways then fight over
					// workspaces (observed: reconnect storms in the desktop).
					let stopped = shutdown_gateway(socket_path);
					if !stopped {
						return Ok(());
					}
					clean_stale_socket(socket_path);
					// Fall through to spawn a fresh gateway.
				} else {
					return Ok(());
				}
			} else {
				// Status query failed but ping succeeded — the gateway is
				// likely an old version that doesn't report `version` in
				// status. Try to replace it, but never force-unlink a live
				// socket (see the version-mismatch branch above).
				let stopped = shutdown_gateway(socket_path);
				if !stopped {
					return Ok(());
				}
				clean_stale_socket(socket_path);
			}
		} else {
			return Ok(());
		}
	}
	// Not ready — but "no answer" may be a transient miss (a busy gateway
	// fanning out agent events can miss a 2s ping). Re-probe briefly before
	// deciding the daemon is gone: spawning beside a live gateway is how
	// duplicate daemons (and duplicate agents) accumulate.
	{
		let probe_deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
		while std::time::Instant::now() < probe_deadline {
			std::thread::sleep(std::time::Duration::from_millis(300));
			if gateway_ready(socket_path) {
				return Ok(());
			}
		}
	}
	let env_pizza = std::env::var("PIZZA_BIN").ok();
	// Resolve the main agent directory so the gateway can pass --main to
	// sub-agents spawned for that cwd. The gateway itself does NOT run as
	// the main agent (no --main flag); it just needs to know the path.
	let main_dir = std::env::var("HOME")
		.or_else(|_| std::env::var("USERPROFILE"))
		.ok()
		.map(|h| {
			PathBuf::from(h)
				.join(".pizza")
				.join("main")
				.to_string_lossy()
				.to_string()
		});
	let (program, base_args): (String, Vec<String>) = if let Some(bin) = env_pizza {
		let parts: Vec<&str> = bin.split_whitespace().collect();
		let p = parts[0].to_string();
		let mut a: Vec<String> = parts[1..].iter().map(|s| s.to_string()).collect();
		a.extend(["--mode".to_string(), "gateway".to_string()]);
		if let Some(ref md) = main_dir {
			a.extend(["--main-dir".to_string(), md.clone()]);
		}
		(p, a)
	} else {
		(pizza_cmd.0.to_string(), {
			let mut v = pizza_cmd.1.to_vec();
			v.extend(["--mode".to_string(), "gateway".to_string()]);
			if let Some(ref md) = main_dir {
				v.extend(["--main-dir".to_string(), md.clone()]);
			}
			v
		})
	};
	let mut cmd = Command::new(&program);
	cmd.args(&base_args);
	cmd.envs(std::env::vars().filter(|(k, _)| k != "PIZZA_BIN"));
	cmd.env(
		"PIZZA_GATEWAY_SOCKET",
		socket_path.to_string_lossy().to_string(),
	);
	cmd.stdin(Stdio::null());
	cmd.stdout(Stdio::null());
	cmd.stderr(Stdio::null());
	// On Windows, detach the child from this console so it survives exit.
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		// DETACHED_PROCESS = 0x00000008; CREATE_NEW_PROCESS_GROUP = 0x00000200.
		cmd.creation_flags(0x00000008 | 0x00000200);
	}
	let child = cmd
		.spawn()
		.map_err(|e| format!("Failed to spawn gateway: {e}"))?;
	// Detach so it outlives the desktop process.
	let _ = child.id();
	// Wait for the socket/pipe to respond.
	let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
	while std::time::Instant::now() < deadline {
		std::thread::sleep(std::time::Duration::from_millis(100));
		if gateway_ready(socket_path) {
			return Ok(());
		}
	}
	Err(format!(
		"Gateway failed to start within 15s (socket: {})",
		socket_path.display()
	))
}

/// Parsed `status_result` from the gateway — just the fields we need for the
/// version check and busy-agent drain.
struct GatewayStatus {
	version: String,
	agents: Vec<bool>, // busy flags
}

/// Send `{"type":"status"}` to the gateway and parse the response. Returns
/// None if the gateway is unreachable or the response is malformed. Runs on a
/// background thread with a 3s deadline so a hung gateway can't stall the
/// caller (same pattern as `ping_gateway`).
fn query_gateway_status(socket_path: &PathBuf) -> Option<GatewayStatus> {
	let path = socket_path.clone();
	let (tx, rx) = std::sync::mpsc::channel();
	thread::spawn(move || {
		let result = (|| -> Result<GatewayStatus, String> {
			let mut stream = open_gateway_stream(&path)?;
			let payload =
				serde_json::to_string(&json!({ "type": "status" })).map_err(|e| e.to_string())?;
			stream
				.write_all(payload.as_bytes())
				.map_err(|e| e.to_string())?;
			stream.write_all(b"\n").map_err(|e| e.to_string())?;
			stream.flush().map_err(|e| e.to_string())?;
			let mut reader = BufReader::new(stream);
			let mut line = String::new();
			reader.read_line(&mut line).map_err(|e| e.to_string())?;
			let parsed: Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
			if parsed.get("type").and_then(|t| t.as_str()) != Some("status_result") {
				return Err("not a status_result".into());
			}
			let version = parsed
				.get("version")
				.and_then(|v| v.as_str())
				.unwrap_or("")
				.to_string();
			let agents = parsed
				.get("agents")
				.and_then(|a| a.as_array())
				.map(|arr| {
					arr.iter()
						.map(|a| a.get("busy").and_then(|b| b.as_bool()).unwrap_or(false))
						.collect()
				})
				.unwrap_or_default();
			Ok(GatewayStatus { version, agents })
		})();
		let _ = tx.send(result);
	});
	match rx.recv_timeout(std::time::Duration::from_secs(3)) {
		Ok(Ok(status)) => Some(status),
		_ => None,
	}
}

/// True if any agent in the status is currently busy (mid-turn).
fn status_has_busy_agents(status: &GatewayStatus) -> bool {
	status.agents.iter().any(|&busy| busy)
}

/// Send `{"type":"shutdown"}` to the gateway and wait for it to stop.
/// Returns true if the gateway stopped within 10s.
fn shutdown_gateway(socket_path: &PathBuf) -> bool {
	// Send shutdown (best-effort — the gateway may close the connection
	// before replying, which is fine). We don't read the response.
	if let Ok(mut stream) = open_gateway_stream(socket_path) {
		let payload = serde_json::to_string(&json!({ "type": "shutdown" }));
		if let Ok(payload) = payload {
			let _ = stream.write_all(payload.as_bytes());
			let _ = stream.write_all(b"\n");
			let _ = stream.flush();
		}
	}
	// Wait for the socket to disappear (Unix) or ping to fail (all platforms).
	let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
	while std::time::Instant::now() < deadline {
		std::thread::sleep(std::time::Duration::from_millis(200));
		if !gateway_ready(socket_path) {
			return true;
		}
	}
	false
}

/// Remove a stale socket file (Unix only — Windows named pipes have no file).
fn clean_stale_socket(socket_path: &PathBuf) {
	#[cfg(unix)]
	{
		if socket_path.exists() {
			let _ = std::fs::remove_file(socket_path);
		}
	}
}

/// True if the gateway is listening and answers a ping. On Unix the socket
/// file must exist first (cheap stat); on Windows a named pipe has no
/// filesystem entry, so we probe by connecting directly.
#[cfg(unix)]
fn gateway_ready(socket_path: &PathBuf) -> bool {
	socket_path.exists() && ping_gateway(socket_path).unwrap_or(false)
}

#[cfg(windows)]
fn gateway_ready(socket_path: &PathBuf) -> bool {
	ping_gateway(socket_path).unwrap_or(false)
}

/// Ping the gateway; true if it answers pong. Runs the probe on a background
/// thread with a 2s deadline so a hung/nonexistent gateway can't stall the
/// caller (named-pipe reads have no portable per-op timeout on Windows, and
/// this keeps the Unix and Windows paths uniform).
fn ping_gateway(socket_path: &PathBuf) -> Result<bool, String> {
	let path = socket_path.clone();
	let (tx, rx) = std::sync::mpsc::channel();
	thread::spawn(move || {
		let result = open_gateway_stream(&path).and_then(ping_with_stream);
		let _ = tx.send(result);
	});
	match rx.recv_timeout(std::time::Duration::from_secs(2)) {
		Ok(Ok(pong)) => Ok(pong),
		// A connect/read error means "not ready yet" → not a hard failure.
		Ok(Err(_)) => Ok(false),
		// Timeout or sender dropped (thread panicked) → treat as not ready.
		Err(_) => Ok(false),
	}
}

/// Open a fresh read+write stream to the gateway for a ping. One connection
/// per probe; the long-lived channel uses `GatewayChannel::connect`.
#[cfg(unix)]
fn open_gateway_stream(socket_path: &PathBuf) -> Result<Box<dyn ReadWrite + Send>, String> {
	let stream = UnixStream::connect(socket_path).map_err(|e| e.to_string())?;
	stream
		.set_read_timeout(Some(std::time::Duration::from_secs(2)))
		.map_err(|e| e.to_string())?;
	Ok(Box::new(stream))
}

#[cfg(windows)]
fn open_gateway_stream(socket_path: &PathBuf) -> Result<Box<dyn ReadWrite + Send>, String> {
	let pipe_name = socket_path.to_string_lossy().to_string();
	let timeout = Some(Duration::from_secs(2));
	let pipe = win_pipe::PipeStream::connect(&pipe_name, timeout, timeout)?;
	Ok(Box::new(pipe))
}

/// Send `{"type":"ping"}` and check for a `pong` reply on a single stream.
fn ping_with_stream(mut stream: Box<dyn ReadWrite + Send>) -> Result<bool, String> {
	let payload = serde_json::to_string(&json!({ "type": "ping" })).map_err(|e| e.to_string())?;
	stream
		.write_all(payload.as_bytes())
		.map_err(|e| e.to_string())?;
	stream.write_all(b"\n").map_err(|e| e.to_string())?;
	stream.flush().map_err(|e| e.to_string())?;
	let mut reader = BufReader::new(stream);
	let mut line = String::new();
	reader.read_line(&mut line).map_err(|e| e.to_string())?;
	let parsed: Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
	Ok(parsed.get("type").and_then(|t| t.as_str()) == Some("pong"))
}

/// Windows named-pipe client using OVERLAPPED I/O.
///
/// Why not `std::fs::File` + `try_clone()`: a handle opened without
/// `FILE_FLAG_OVERLAPPED` is a synchronous file object, and the I/O manager
/// serializes all synchronous I/O on one file object. `try_clone`
/// (DuplicateHandle) shares that object, so the channel's reader thread —
/// parked in `ReadFile` waiting for gateway output — blocks every
/// `WriteFile` from the request side. After `attach_ok` the gateway has
/// nothing to say until it receives `get_state`, which can never be written:
/// a permanent deadlock (the desktop "starting…" hang).
///
/// With overlapped I/O each operation gets its own `OVERLAPPED` + event, so a
/// pending read and a write proceed independently. It also gives us real
/// per-operation timeouts (`CancelIoEx`) and a race-free `close()`.
#[cfg(windows)]
mod win_pipe {
	use std::io;
	use std::sync::atomic::{AtomicBool, Ordering};
	use std::sync::Arc;
	use std::time::{Duration, Instant};
	use windows_sys::Win32::Foundation::{
		CloseHandle, GetLastError, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED,
		ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
		INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
	};
	use windows_sys::Win32::Storage::FileSystem::{
		CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ, FILE_SHARE_WRITE,
		OPEN_EXISTING,
	};
	use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
	use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
	use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

	/// How often a blocked operation re-checks `closed` / its deadline.
	const POLL_SLICE_MS: u32 = 250;
	/// How long `connect` waits for a free instance of a busy pipe.
	const BUSY_WAIT: Duration = Duration::from_secs(2);

	struct OwnedHandle(HANDLE);
	// SAFETY: a Win32 HANDLE is a process-wide kernel object reference;
	// overlapped operations on it are thread-safe.
	unsafe impl Send for OwnedHandle {}
	unsafe impl Sync for OwnedHandle {}
	impl Drop for OwnedHandle {
		fn drop(&mut self) {
			unsafe { CloseHandle(self.0) };
		}
	}

	struct Inner {
		handle: OwnedHandle,
		closed: AtomicBool,
	}

	/// Cheap to clone; all clones share one pipe connection. The handle is
	/// closed when the last clone drops.
	#[derive(Clone)]
	pub struct PipeStream {
		inner: Arc<Inner>,
		read_timeout: Option<Duration>,
		write_timeout: Option<Duration>,
	}

	impl PipeStream {
		pub fn connect(
			pipe_name: &str,
			read_timeout: Option<Duration>,
			write_timeout: Option<Duration>,
		) -> Result<Self, String> {
			let wide: Vec<u16> = pipe_name.encode_utf16().chain(Some(0)).collect();
			let busy_deadline = Instant::now() + BUSY_WAIT;
			let handle = loop {
				let handle = unsafe {
					CreateFileW(
						wide.as_ptr(),
						GENERIC_READ | GENERIC_WRITE,
						FILE_SHARE_READ | FILE_SHARE_WRITE,
						std::ptr::null(),
						OPEN_EXISTING,
						FILE_FLAG_OVERLAPPED,
						0,
					)
				};
				if handle != INVALID_HANDLE_VALUE {
					break handle;
				}
				let err = io::Error::last_os_error();
				// Every server instance is momentarily taken (connection
				// burst): the gateway is alive. Treating this as "not
				// running" made ensure_gateway spawn a duplicate daemon.
				if err.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
					&& Instant::now() < busy_deadline
				{
					unsafe { WaitNamedPipeW(wide.as_ptr(), POLL_SLICE_MS) };
					continue;
				}
				return Err(format!(
					"Failed to connect to gateway pipe {}: {}",
					pipe_name, err
				));
			};
			Ok(Self {
				inner: Arc::new(Inner {
					handle: OwnedHandle(handle),
					closed: AtomicBool::new(false),
				}),
				read_timeout,
				write_timeout,
			})
		}

		/// Abort in-flight operations and make all future ones fail. Pending
		/// waits notice within one poll slice even if no I/O was in flight at
		/// the moment of the call.
		pub fn close(&self) {
			self.inner.closed.store(true, Ordering::SeqCst);
			unsafe { CancelIoEx(self.inner.handle.0, std::ptr::null()) };
		}

		/// Start one overlapped operation via `start` and block until it
		/// completes, times out, or the stream is closed. The OVERLAPPED and
		/// buffer stay alive until the kernel is done with them: after a
		/// cancel we still wait (bWait=TRUE) for the completion.
		fn overlapped_io(
			&self,
			timeout: Option<Duration>,
			start: impl FnOnce(HANDLE, *mut OVERLAPPED) -> i32,
		) -> io::Result<usize> {
			if self.inner.closed.load(Ordering::SeqCst) {
				return Err(io::Error::new(io::ErrorKind::NotConnected, "pipe closed"));
			}
			let handle = self.inner.handle.0;
			let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
			if event == 0 {
				return Err(io::Error::last_os_error());
			}
			let event = OwnedHandle(event);
			let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
			ov.hEvent = event.0;
			if start(handle, &mut ov) == 0 {
				let err = unsafe { GetLastError() };
				if err != ERROR_IO_PENDING {
					return Err(io::Error::from_raw_os_error(err as i32));
				}
			}
			let deadline = timeout.map(|t| Instant::now() + t);
			let mut timed_out = false;
			loop {
				if unsafe { WaitForSingleObject(event.0, POLL_SLICE_MS) } == WAIT_OBJECT_0 {
					break;
				}
				let expired = deadline.is_some_and(|d| Instant::now() >= d);
				if expired || self.inner.closed.load(Ordering::SeqCst) {
					timed_out = expired;
					unsafe { CancelIoEx(handle, &ov) };
					break;
				}
			}
			let mut n: u32 = 0;
			if unsafe { GetOverlappedResult(handle, &ov, &mut n, 1) } == 0 {
				let err = unsafe { GetLastError() };
				return Err(match err {
					ERROR_OPERATION_ABORTED if timed_out => {
						io::Error::new(io::ErrorKind::TimedOut, "pipe operation timed out")
					}
					ERROR_OPERATION_ABORTED => {
						io::Error::new(io::ErrorKind::NotConnected, "pipe closed")
					}
					_ => io::Error::from_raw_os_error(err as i32),
				});
			}
			Ok(n as usize)
		}
	}

	impl io::Read for PipeStream {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			if buf.is_empty() {
				return Ok(0);
			}
			let len = buf.len().min(u32::MAX as usize) as u32;
			let ptr = buf.as_mut_ptr();
			match self.overlapped_io(self.read_timeout, |h, ov| unsafe {
				ReadFile(h, ptr, len, std::ptr::null_mut(), ov)
			}) {
				// The server closing its end is EOF, not an error.
				Err(e)
					if e.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32)
						|| e.raw_os_error() == Some(ERROR_PIPE_NOT_CONNECTED as i32) =>
				{
					Ok(0)
				}
				r => r,
			}
		}
	}

	impl io::Write for PipeStream {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			if buf.is_empty() {
				return Ok(0);
			}
			let len = buf.len().min(u32::MAX as usize) as u32;
			let ptr = buf.as_ptr();
			self.overlapped_io(self.write_timeout, |h, ov| unsafe {
				WriteFile(h, ptr, len, std::ptr::null_mut(), ov)
			})
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
}

#[cfg(not(any(unix, windows)))]
mod _unsupported_stub {
	//! No gateway transport on this platform. Keeps the crate compiling.
	use super::*;
	impl GatewayChannel {
		pub fn connect(_socket_path: &PathBuf) -> Result<Self, String> {
			Err("gateway channel is not implemented on this platform".into())
		}
	}
	pub fn ensure_gateway(
		_socket_path: &PathBuf,
		_pizza_cmd: (&str, &[String]),
		_expected_version: Option<&str>,
	) -> Result<(), String> {
		Err("gateway channel is not implemented on this platform".into())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dispatch_routes_response_by_id_and_events_to_inbox() {
		let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
		let inbox: Arc<Mutex<Vec<ChannelMessage>>> = Arc::new(Mutex::new(Vec::new()));
		let slot: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
		pending
			.lock()
			.unwrap()
			.insert("req_1".to_string(), Arc::clone(&slot));

		// A response with id req_1 → fills the slot, NOT the inbox.
		GatewayChannel::dispatch(
			&json!({ "type": "rpc", "workspace": "/x", "frame": { "id": "req_1", "type": "response" } }),
			&pending,
			&inbox,
		);
		assert!(slot.lock().unwrap().is_some());
		assert!(inbox.lock().unwrap().is_empty());

		// An event (no matching id) → inbox.
		GatewayChannel::dispatch(
			&json!({ "type": "rpc", "workspace": "/x", "frame": { "type": "AGENT_MESSAGE" } }),
			&pending,
			&inbox,
		);
		assert!(matches!(
			inbox.lock().unwrap().last(),
			Some(ChannelMessage::Event { .. })
		));

		// attach_ok / list_result / error → inbox.
		GatewayChannel::dispatch(
			&json!({ "type": "attach_ok", "workspace": "/x" }),
			&pending,
			&inbox,
		);
		GatewayChannel::dispatch(
			&json!({ "type": "error", "message": "boom" }),
			&pending,
			&inbox,
		);
		assert!(inbox
			.lock()
			.unwrap()
			.iter()
			.any(|m| matches!(m, ChannelMessage::AttachOk { .. })));
		assert!(inbox
			.lock()
			.unwrap()
			.iter()
			.any(|m| matches!(m, ChannelMessage::Error(_))));
	}

	#[cfg(unix)]
	mod live_tests {
		use super::*;
		use std::os::unix::net::UnixListener;
		use std::path::PathBuf;
		use std::thread;

		fn tmp_sock() -> PathBuf {
			let p = std::env::temp_dir().join(format!(
				"pizza-gw-test-{}-{}-{}.sock",
				std::process::id(),
				line!(),
				random_u32()
			));
			let _ = std::fs::remove_file(&p);
			p
		}

		fn random_u32() -> u32 {
			use std::time::SystemTime;
			let dur = SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap();
			dur.subsec_nanos().wrapping_mul(2654435761)
		}

		/// A scripted step: optionally wait for one incoming line, then send a reply.
		struct Step {
			consume_input: bool,
			reply: String,
		}

		/// A fake gateway: accept one connection, then play a scripted conversation.
		fn spawn_fake_server(sock: PathBuf, script: Vec<Step>) {
			thread::spawn(move || {
				let listener = match UnixListener::bind(&sock) {
					Ok(l) => l,
					Err(_) => return,
				};
				let (mut stream, _) = match listener.accept() {
					Ok(s) => s,
					Err(_) => return,
				};
				let reader = BufReader::new(stream.try_clone().unwrap());
				let mut lines = reader.lines();
				for step in script {
					if step.consume_input {
						let _ = lines.next();
					}
					let _ = writeln!(stream, "{}", step.reply);
					let _ = stream.flush();
				}
				thread::sleep(std::time::Duration::from_millis(200));
			});
			thread::sleep(std::time::Duration::from_millis(50));
		}

		#[test]
		fn connect_attach_rpc_and_event_over_real_socket() {
			let sock = tmp_sock();
			// Script: reply to attach with attach_ok, to rpc with an id-matched
			// response, then push a fanned-out event.
			spawn_fake_server(
				sock.clone(),
				vec![
					Step { consume_input: true, reply: r#"{"type":"attach_ok","workspace":"/proj"}"#.to_string() },
					Step { consume_input: true, reply: r#"{"type":"rpc","workspace":"/proj","frame":{"id":"r1","type":"response","command":"get_state","success":true}}"#.to_string() },
					Step { consume_input: false, reply: r#"{"type":"rpc","workspace":"/proj","frame":{"type":"AGENT_MESSAGE","text":"hi"}}"#.to_string() },
				],
			);

			let client = GatewayChannel::connect(&sock).expect("connect");
			let cwd = client.attach("/proj").expect("attach");
			assert_eq!(cwd, "/proj");

			let resp = client
				.rpc("/proj", json!({ "id": "r1", "type": "get_state" }))
				.expect("rpc");
			assert_eq!(resp.get("id").and_then(|v| v.as_str()), Some("r1"));
			assert_eq!(resp.get("type").and_then(|v| v.as_str()), Some("response"));

			// The event should land in the inbox.
			let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
			let mut got_event = false;
			while std::time::Instant::now() < deadline {
				let drained = client.drain_events();
				if drained
					.iter()
					.any(|m| matches!(m, ChannelMessage::Event { frame, .. } if frame.get("type").and_then(|v| v.as_str()) == Some("AGENT_MESSAGE")))
				{
					got_event = true;
					break;
				}
				std::thread::sleep(std::time::Duration::from_millis(20));
			}
			assert!(got_event, "fan-out event should reach the inbox");
		}

		#[test]
		fn close_releases_reader_and_rejects_further_rpc() {
			let sock = tmp_sock();
			// A gateway that accepts but never answers.
			let listener = UnixListener::bind(&sock).expect("bind");
			thread::spawn(move || {
				let _conn = listener.accept();
				thread::sleep(std::time::Duration::from_secs(5));
			});

			let client = GatewayChannel::connect(&sock).expect("connect");
			assert!(client.is_alive());
			client.close();
			assert!(!client.is_alive());

			let started = std::time::Instant::now();
			assert!(client
				.rpc("/proj", json!({ "id": "r1", "type": "get_state" }))
				.is_err());
			assert!(started.elapsed() < std::time::Duration::from_secs(1));

			// The reader thread must observe the shutdown and report it.
			let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
			let mut disconnected = false;
			while !disconnected && std::time::Instant::now() < deadline {
				disconnected = client
					.drain_events()
					.iter()
					.any(|m| matches!(m, ChannelMessage::Disconnected));
				std::thread::sleep(std::time::Duration::from_millis(20));
			}
			assert!(disconnected, "reader should exit after close()");
		}

		#[test]
		fn connect_error_on_missing_socket() {
			let sock = tmp_sock();
			assert!(GatewayChannel::connect(&sock).is_err());
		}
	}

	/// Named-pipe tests for the Windows transport. The regression they guard
	/// against is a deadlock (a write queued behind the reader's pending
	/// read), so every client-side step runs under `within_deadline`: a
	/// regression must FAIL, not hang CI.
	#[cfg(windows)]
	mod windows_live_tests {
		use super::*;
		use std::fs::File;
		use std::os::windows::io::{FromRawHandle, RawHandle};
		use std::sync::atomic::AtomicUsize;
		use std::sync::mpsc;
		use std::time::Instant;
		use windows_sys::Win32::Foundation::{
			GetLastError, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE,
		};
		use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
		use windows_sys::Win32::System::Pipes::{
			ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
		};

		const TEST_DEADLINE: Duration = Duration::from_secs(10);

		fn unique_pipe_name() -> String {
			static N: AtomicUsize = AtomicUsize::new(0);
			format!(
				r"\\.\pipe\pizza-gw-test-{}-{}",
				std::process::id(),
				N.fetch_add(1, Ordering::SeqCst)
			)
		}

		/// Create the server end now (so the client can connect right
		/// away), then run `serve` with the connected pipe on a thread. The
		/// server side uses plain synchronous I/O from a single thread,
		/// like a well-behaved gateway would.
		fn spawn_pipe_server(name: &str, buf_size: u32, serve: impl FnOnce(File) + Send + 'static) {
			let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
			let handle = unsafe {
				CreateNamedPipeW(
					wide.as_ptr(),
					PIPE_ACCESS_DUPLEX,
					PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
					1,
					buf_size,
					buf_size,
					0,
					std::ptr::null(),
				)
			};
			assert_ne!(handle, INVALID_HANDLE_VALUE, "CreateNamedPipeW failed");
			thread::spawn(move || {
				let ok = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
				if ok == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
					return;
				}
				serve(unsafe { File::from_raw_handle(handle as RawHandle) });
			});
		}

		fn within_deadline<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
			let (tx, rx) = mpsc::channel();
			thread::spawn(move || {
				let _ = tx.send(f());
			});
			match rx.recv_timeout(TEST_DEADLINE) {
				Ok(v) => v,
				Err(mpsc::RecvTimeoutError::Timeout) => {
					panic!("pipe I/O did not complete within {TEST_DEADLINE:?} (deadlock?)")
				}
				Err(mpsc::RecvTimeoutError::Disconnected) => panic!("test body panicked"),
			}
		}

		fn read_line(reader: &mut BufReader<File>) -> String {
			let mut line = String::new();
			reader.read_line(&mut line).expect("server read");
			line
		}

		/// The root cause, at the transport level: a write must go through
		/// while another thread is parked in a read on the same connection.
		#[test]
		fn write_proceeds_while_read_is_pending() {
			let name = unique_pipe_name();
			spawn_pipe_server(&name, 4096, |file| {
				let mut writer = file.try_clone().unwrap();
				let mut reader = BufReader::new(file);
				let line = read_line(&mut reader);
				writer.write_all(format!("echo:{line}").as_bytes()).unwrap();
				thread::sleep(Duration::from_secs(1));
			});
			let pipe = win_pipe::PipeStream::connect(&name, None, None).expect("connect");
			let mut read_half = pipe.clone();
			let reader = thread::spawn(move || {
				let mut line = String::new();
				BufReader::new(&mut read_half)
					.read_line(&mut line)
					.map(|_| line)
			});
			// Let the reader park in ReadFile before writing.
			thread::sleep(Duration::from_millis(200));
			let echoed = within_deadline(move || {
				let mut w = pipe;
				w.write_all(b"hello\n").expect("write");
				reader.join().unwrap().expect("read")
			});
			assert_eq!(echoed, "echo:hello\n");
		}

		/// The original symptom end-to-end: attach_ok arrives, the gateway
		/// then stays silent until it receives get_state.
		#[test]
		fn rpc_after_attach_does_not_deadlock() {
			let name = unique_pipe_name();
			spawn_pipe_server(&name, 4096, |file| {
				let mut writer = file.try_clone().unwrap();
				let mut reader = BufReader::new(file);
				assert!(read_line(&mut reader).contains(r#""type":"attach""#));
				writeln!(writer, r#"{{"type":"attach_ok","workspace":"/proj"}}"#).unwrap();
				let rpc: Value = serde_json::from_str(&read_line(&mut reader)).unwrap();
				let id = rpc["frame"]["id"].as_str().unwrap().to_string();
				writeln!(
					writer,
					"{}",
					json!({ "type": "rpc", "workspace": "/proj",
						"frame": { "id": id, "type": "response", "command": "get_state", "success": true } })
				)
				.unwrap();
				thread::sleep(Duration::from_secs(1));
			});
			let path = PathBuf::from(&name);
			let resp = within_deadline(move || {
				let client = GatewayChannel::connect(&path).expect("connect");
				assert_eq!(client.attach("/proj").expect("attach"), "/proj");
				// Make sure the reader is parked in ReadFile again.
				thread::sleep(Duration::from_millis(200));
				client.rpc("/proj", json!({ "id": "r1", "type": "get_state" }))
			})
			.expect("rpc");
			assert_eq!(resp["id"], "r1");
			assert_eq!(resp["type"], "response");
		}

		#[test]
		fn write_times_out_when_server_stops_reading() {
			let name = unique_pipe_name();
			spawn_pipe_server(&name, 4096, |_file| thread::sleep(Duration::from_secs(5)));
			let timeout = Duration::from_millis(300);
			let pipe = win_pipe::PipeStream::connect(&name, None, Some(timeout)).expect("connect");
			let (err, elapsed) = within_deadline(move || {
				let started = Instant::now();
				let mut w = pipe;
				let err = w
					.write_all(&vec![b'x'; 1 << 20])
					.expect_err("write must time out");
				(err, started.elapsed())
			});
			assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
			assert!(elapsed < Duration::from_secs(5), "took {elapsed:?}");
		}

		#[test]
		fn read_times_out_when_server_is_silent() {
			let name = unique_pipe_name();
			spawn_pipe_server(&name, 4096, |_file| thread::sleep(Duration::from_secs(5)));
			let timeout = Some(Duration::from_millis(300));
			let pipe = win_pipe::PipeStream::connect(&name, timeout, None).expect("connect");
			let err = within_deadline(move || {
				let mut r = pipe;
				r.read(&mut [0u8; 16]).expect_err("read must time out")
			});
			assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
		}

		#[test]
		fn close_unblocks_pending_read_and_rejects_further_io() {
			let name = unique_pipe_name();
			spawn_pipe_server(&name, 4096, |_file| thread::sleep(Duration::from_secs(5)));
			let pipe = win_pipe::PipeStream::connect(&name, None, None).expect("connect");
			let mut read_half = pipe.clone();
			let reader = thread::spawn(move || read_half.read(&mut [0u8; 16]));
			thread::sleep(Duration::from_millis(200));
			pipe.close();
			let result = within_deadline(move || reader.join().unwrap());
			assert_eq!(
				result.expect_err("read must fail").kind(),
				std::io::ErrorKind::NotConnected
			);
			let mut w = pipe;
			assert!(w.write(b"x").is_err());
		}

		#[test]
		fn server_disconnect_is_reported_as_disconnected() {
			let name = unique_pipe_name();
			spawn_pipe_server(&name, 4096, |file| {
				thread::sleep(Duration::from_millis(200));
				drop(file);
			});
			let client = GatewayChannel::connect(&PathBuf::from(&name)).expect("connect");
			let client_for_wait = client.clone();
			within_deadline(move || loop {
				if client_for_wait
					.drain_events()
					.iter()
					.any(|m| matches!(m, ChannelMessage::Disconnected))
				{
					break;
				}
				thread::sleep(Duration::from_millis(20));
			});
			assert!(!client.is_alive());
		}

		#[test]
		fn channel_close_releases_reader_and_rejects_rpc() {
			let name = unique_pipe_name();
			spawn_pipe_server(&name, 4096, |_file| thread::sleep(Duration::from_secs(5)));
			let client = GatewayChannel::connect(&PathBuf::from(&name)).expect("connect");
			thread::sleep(Duration::from_millis(200));
			client.close();
			assert!(!client.is_alive());
			let c = client.clone();
			within_deadline(move || {
				assert!(c
					.rpc("/proj", json!({ "id": "r1", "type": "get_state" }))
					.is_err());
				while !c
					.drain_events()
					.iter()
					.any(|m| matches!(m, ChannelMessage::Disconnected))
				{
					thread::sleep(Duration::from_millis(20));
				}
			});
		}
	}
}
