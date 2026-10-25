/**
 * SSH remote workspace support for the desktop bridge.
 *
 * The local app uses the system OpenSSH client so authentication, agent
 * forwarding, proxy settings, and known_hosts verification stay aligned with
 * the user's normal SSH setup. The remote Pizza process owns the workspace;
 * the desktop only transports RPC and short-lived read-only filesystem calls.
 */
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const REMOTE_KEY_PREFIX: &str = "remote://";
const REMOTE_STORAGE_VERSION: u32 = 1;
const SSH_CONNECT_TIMEOUT_SECONDS: u64 = 15;
const SSH_KEEPALIVE_INTERVAL_SECONDS: u64 = 15;
const SSH_KEEPALIVE_COUNT_MAX: u64 = 3;
const SSH_CONTROL_PERSIST_SECONDS: u64 = 60;
const FS_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER_PROVISION_SCHEMA_VERSION: u32 = 1;
const PROVIDER_CREDENTIAL_SCHEMA_VERSION: u32 = 1;
const REMOTE_PIZZA_DISCOVERY_SCRIPT: &str = r#"
candidate="$(command -v pizza 2>/dev/null || true)"
if [ -n "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
  printf '%s\n' "$candidate"
  exit 0
fi
for candidate in \
  "$HOME/.pizza/bin/pizza" \
  "$HOME/.local/bin/pizza" \
  "$HOME/.npm-global/bin/pizza" \
  /usr/local/bin/pizza \
  /opt/homebrew/bin/pizza \
  /usr/bin/pizza
do
  if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
    printf '%s\n' "$candidate"
    exit 0
  fi
done
if command -v npm >/dev/null 2>&1; then
  prefix="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$prefix" ]; then
    for candidate in "$prefix/bin/pizza" "$prefix/pizza"; do
      if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
        printf '%s\n' "$candidate"
        exit 0
      fi
    done
  fi
fi
exit 127
"#;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceConfig {
	pub id: String,
	pub label: String,
	pub ssh_target: String,
	pub port: Option<u16>,
	pub identity_file: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub password: Option<String>,
	pub remote_path: String,
	pub pizza_command: Option<String>,
	pub created_at: i64,
	pub last_accessed_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteWorkspaceStore {
	version: u32,
	workspaces: Vec<RemoteWorkspaceConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRemoteWorkspaceInput {
	pub label: String,
	pub ssh_target: String,
	pub port: Option<u16>,
	pub identity_file: Option<String>,
	pub password: Option<String>,
	pub remote_path: String,
	pub pizza_command: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSshInput {
	pub ssh_target: String,
	pub port: Option<u16>,
	pub identity_file: Option<String>,
	pub password: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectoryEntry {
	pub name: String,
	pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectoryListing {
	pub current_path: String,
	pub home_path: String,
	pub parent_path: Option<String>,
	pub entries: Vec<RemoteDirectoryEntry>,
}

pub struct RemoteCommandOutput {
	pub stdout: String,
	pub stderr: String,
	pub success: bool,
}

fn now_millis() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis() as i64
}

fn home_dir() -> Option<PathBuf> {
	std::env::var_os("HOME")
		.map(PathBuf::from)
		.or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn ssh_program() -> String {
	std::env::var("PIZZA_SSH_BIN")
		.ok()
		.filter(|value| !value.trim().is_empty())
		.unwrap_or_else(|| "ssh".to_string())
}

fn ssh_askpass_path() -> Result<PathBuf, String> {
	let path = home_dir()
		.ok_or_else(|| "could not determine home directory".to_string())?
		.join(".pizza")
		.join("desktop")
		.join("ssh-askpass.sh");
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent)
			.map_err(|e| format!("Failed to create SSH askpass directory: {e}"))?;
	}
	std::fs::write(&path, "#!/bin/sh\nprintf '%s\\n' \"$PIZZA_SSH_PASSWORD\"\n")
		.map_err(|e| format!("Failed to write SSH askpass helper: {e}"))?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
			.map_err(|e| format!("Failed to secure SSH askpass helper: {e}"))?;
	}
	Ok(path)
}

fn ssh_command(config: &RemoteWorkspaceConfig) -> Result<Command, String> {
	let mut command = Command::new(ssh_program());
	if let Some(password) = config.password.as_deref().filter(|value| !value.is_empty()) {
		#[cfg(windows)]
		{
			let _ = password;
			return Err(
				"Password authentication is not supported on Windows yet; use an SSH key or ssh-agent"
					.to_string(),
			);
		}
		#[cfg(not(windows))]
		{
			let askpass = ssh_askpass_path()?;
			command
				.env("PIZZA_SSH_PASSWORD", password)
				.env("SSH_ASKPASS", askpass)
				.env("SSH_ASKPASS_REQUIRE", "force")
				.env(
					"DISPLAY",
					std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_string()),
				);
		}
	}
	Ok(command)
}

fn remote_storage_path() -> Result<PathBuf, String> {
	home_dir()
		.map(|home| {
			home.join(".pizza")
				.join("desktop")
				.join("remote-workspaces.json")
		})
		.ok_or_else(|| "could not determine home directory".to_string())
}

pub fn workspace_key(id: &str) -> String {
	format!("{REMOTE_KEY_PREFIX}{id}")
}

pub fn workspace_id_from_key(key: &str) -> Option<&str> {
	key.strip_prefix(REMOTE_KEY_PREFIX)
		.filter(|id| !id.is_empty())
}

pub fn is_remote_workspace_key(key: &str) -> bool {
	workspace_id_from_key(key).is_some()
}

fn validate_no_control_chars(value: &str, field: &str) -> Result<(), String> {
	if value.chars().any(|c| c.is_control()) {
		return Err(format!("{field} contains invalid control characters"));
	}
	Ok(())
}

fn validate_ssh_input(input: &RemoteSshInput) -> Result<(), String> {
	let target = input.ssh_target.trim();
	if target.is_empty() || target.starts_with('-') || target.chars().any(char::is_whitespace) {
		return Err("SSH target must be a host or user@host without spaces".to_string());
	}
	validate_no_control_chars(target, "SSH target")?;
	if input.port == Some(0) {
		return Err("SSH port must be between 1 and 65535".to_string());
	}
	if let Some(password) = input.password.as_deref().filter(|value| !value.is_empty()) {
		validate_no_control_chars(password, "Password")?;
	}
	if let Some(identity) = input
		.identity_file
		.as_deref()
		.map(str::trim)
		.filter(|v| !v.is_empty())
	{
		validate_no_control_chars(identity, "Identity file")?;
	}
	Ok(())
}

pub fn validate_add_input(input: &AddRemoteWorkspaceInput) -> Result<(), String> {
	let label = input.label.trim();
	if label.is_empty() || label.len() > 120 {
		return Err("Remote workspace name must be between 1 and 120 characters".to_string());
	}
	validate_ssh_input(&RemoteSshInput {
		ssh_target: input.ssh_target.clone(),
		port: input.port,
		identity_file: input.identity_file.clone(),
		password: input.password.clone(),
	})?;
	let remote_path = input.remote_path.trim();
	if remote_path.is_empty() || !remote_path.starts_with('/') {
		return Err("Remote project directory must be an absolute POSIX path".to_string());
	}
	validate_no_control_chars(remote_path, "Remote project directory")?;
	if let Some(command) = input
		.pizza_command
		.as_deref()
		.map(str::trim)
		.filter(|v| !v.is_empty())
	{
		validate_pizza_command(command)?;
	}
	Ok(())
}

fn validate_pizza_command(command: &str) -> Result<(), String> {
	if command.starts_with('-')
		|| command.chars().any(|c| {
			c.is_whitespace()
				|| matches!(
					c,
					'\'' | '"' | ';' | '&' | '|' | '<' | '>' | '`' | '$' | '\\' | '(' | ')'
				)
		}) {
		return Err(
			"Pizza command must be an executable name or absolute path without shell syntax"
				.to_string(),
		);
	}
	Ok(())
}

fn expand_local_tilde(path: &str) -> PathBuf {
	if path == "~" {
		return home_dir().unwrap_or_else(|| PathBuf::from(path));
	}
	if let Some(rest) = path.strip_prefix("~/") {
		if let Some(home) = home_dir() {
			return home.join(rest);
		}
	}
	PathBuf::from(path)
}

fn base_ssh_args(config: &RemoteWorkspaceConfig) -> Vec<String> {
	let mut args = vec![
		"-o".to_string(),
		if config
			.password
			.as_deref()
			.is_some_and(|value| !value.is_empty())
		{
			"NumberOfPasswordPrompts=1".to_string()
		} else {
			"BatchMode=yes".to_string()
		},
		"-o".to_string(),
		"StrictHostKeyChecking=accept-new".to_string(),
		"-o".to_string(),
		format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}"),
		"-o".to_string(),
		format!("ServerAliveInterval={SSH_KEEPALIVE_INTERVAL_SECONDS}"),
		"-o".to_string(),
		format!("ServerAliveCountMax={SSH_KEEPALIVE_COUNT_MAX}"),
		"-T".to_string(),
	];
	if let Some(port) = config.port {
		args.push("-p".to_string());
		args.push(port.to_string());
	}
	if let Some(identity_file) = config
		.identity_file
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
	{
		args.push("-i".to_string());
		args.push(
			expand_local_tilde(identity_file)
				.to_string_lossy()
				.to_string(),
		);
	}
	args
}

fn ssh_config_from_input(input: RemoteSshInput) -> Result<RemoteWorkspaceConfig, String> {
	validate_ssh_input(&input)?;
	let timestamp = now_millis();
	let id = uuid::Uuid::new_v4().simple().to_string();
	Ok(RemoteWorkspaceConfig {
		id: id[..16].to_string(),
		label: String::new(),
		ssh_target: input.ssh_target.trim().to_string(),
		port: input.port,
		identity_file: input
			.identity_file
			.map(|value| value.trim().to_string())
			.filter(|value| !value.is_empty()),
		password: input.password.filter(|value| !value.is_empty()),
		remote_path: "/".to_string(),
		pizza_command: None,
		created_at: timestamp,
		last_accessed_at: timestamp,
	})
}

pub fn quote_posix_shell_arg(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn pizza_command(config: &RemoteWorkspaceConfig) -> &str {
	config.pizza_command.as_deref().unwrap_or("pizza")
}

fn file_revision(path: &Path) -> Result<String, String> {
	match std::fs::metadata(path) {
		Ok(metadata) => {
			let modified = metadata
				.modified()
				.ok()
				.and_then(|value| value.duration_since(UNIX_EPOCH).ok())
				.map(|value| value.as_nanos())
				.unwrap_or_default();
			Ok(format!("{}:{modified}", metadata.len()))
		}
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("missing".to_string()),
		Err(error) => Err(format!("Failed to inspect {}: {error}", path.display())),
	}
}

fn read_stable_local_file(path: &Path, label: &str) -> Result<(Option<Vec<u8>>, String), String> {
	for _ in 0..3 {
		let before = file_revision(path)?;
		let bytes = if before == "missing" {
			None
		} else {
			Some(std::fs::read(path).map_err(|e| {
				format!("Failed to read local {label} file {}: {e}", path.display())
			})?)
		};
		let after = file_revision(path)?;
		if before == after {
			return Ok((bytes, after));
		}
		std::thread::sleep(Duration::from_millis(20));
	}
	Err(format!(
		"Local {label} file changed repeatedly while reading: {}",
		path.display()
	))
}

fn parse_local_object(bytes: Option<Vec<u8>>, label: &str, path: &Path) -> Result<Value, String> {
	let Some(bytes) = bytes else {
		return Ok(json!({}));
	};
	let parsed: Value = serde_json::from_slice(&bytes)
		.map_err(|e| format!("Invalid local {label} JSON in {}: {e}", path.display()))?;
	if !parsed.is_object() {
		return Err(format!(
			"Local {label} file must contain a JSON object: {}",
			path.display()
		));
	}
	Ok(parsed)
}

fn narrow_string_setting(
	settings: &serde_json::Map<String, Value>,
	field: &str,
) -> Result<Value, String> {
	match settings.get(field) {
		None | Some(Value::Null) => Ok(Value::Null),
		Some(Value::String(value)) => Ok(Value::String(value.clone())),
		Some(_) => Err(format!(
			"Local settings field {field} must be a string or null"
		)),
	}
}

fn build_local_provider_provisioning_envelope(local_agent_dir: &Path) -> Result<Value, String> {
	let auth_path = local_agent_dir.join("auth.json");
	let models_path = local_agent_dir.join("models.json");
	let settings_path = local_agent_dir.join("settings.json");

	for _ in 0..3 {
		let (auth_bytes, auth_revision) = read_stable_local_file(&auth_path, "auth")?;
		let (models_bytes, models_revision) = read_stable_local_file(&models_path, "models")?;
		let (settings_bytes, settings_revision) =
			read_stable_local_file(&settings_path, "settings")?;

		// Cross-file consistency matters: a provider write may update auth and
		// models together. If either file changes again, rebuild the snapshot.
		if file_revision(&auth_path)? != auth_revision
			|| file_revision(&models_path)? != models_revision
			|| file_revision(&settings_path)? != settings_revision
		{
			std::thread::sleep(Duration::from_millis(20));
			continue;
		}

		let auth = parse_local_object(auth_bytes, "auth", &auth_path)?;
		let models = parse_local_object(models_bytes, "models", &models_path)?;
		let settings = parse_local_object(settings_bytes, "settings", &settings_path)?;
		let providers = models
			.get("providers")
			.cloned()
			.unwrap_or_else(|| json!({}));
		if !providers.is_object() {
			return Err(format!(
				"Local models.json providers must be an object: {}",
				models_path.display()
			));
		}
		let settings_object = settings
			.as_object()
			.ok_or_else(|| "Local settings.json must contain an object".to_string())?;

		return Ok(json!({
			"schemaVersion": PROVIDER_PROVISION_SCHEMA_VERSION,
			"syncId": uuid::Uuid::new_v4().to_string(),
			"source": {
				"modelsRevision": models_revision,
				"settingsRevision": settings_revision,
				"credentialsRevision": auth_revision
			},
			"models": {
				"providers": providers
			},
			"settings": {
				"defaultProvider": narrow_string_setting(settings_object, "defaultProvider")?,
				"defaultModel": narrow_string_setting(settings_object, "defaultModel")?,
				"defaultThinkingLevel": narrow_string_setting(settings_object, "defaultThinkingLevel")?
			},
			"credentials": {
				"schemaVersion": PROVIDER_CREDENTIAL_SCHEMA_VERSION,
				"entries": auth
			}
		}));
	}

	Err(
		"Local provider configuration changed repeatedly while building the sync envelope"
			.to_string(),
	)
}

fn remote_provider_provision_command(config: &RemoteWorkspaceConfig) -> String {
	format!(
		"exec {} --mode provider-provision-rpc",
		quote_posix_shell_arg(pizza_command(config))
	)
}

pub fn remote_agent_command(config: &RemoteWorkspaceConfig) -> String {
	format!(
		"cd {} || exit 1; exec {} --mode rpc",
		quote_posix_shell_arg(&config.remote_path),
		quote_posix_shell_arg(pizza_command(config)),
	)
}

fn remote_fs_command(config: &RemoteWorkspaceConfig, request: &Value) -> Result<String, String> {
	let request_json = serde_json::to_string(request).map_err(|e| e.to_string())?;
	Ok(format!(
		"cd {} || exit 1; printf %s {} | exec {} --mode fs-rpc",
		quote_posix_shell_arg(&config.remote_path),
		quote_posix_shell_arg(&request_json),
		quote_posix_shell_arg(pizza_command(config)),
	))
}

pub fn control_socket_path(id: &str) -> PathBuf {
	std::env::temp_dir().join(format!("pizza-ssh-{id}.sock"))
}

/// One SSH master per remote environment. Multiple project directories on the
/// same host share the connection instead of paying a new handshake per switch.
pub fn environment_control_socket_path(config: &RemoteWorkspaceConfig) -> PathBuf {
	let mut hasher = DefaultHasher::new();
	config.ssh_target.hash(&mut hasher);
	config.port.unwrap_or(22).hash(&mut hasher);
	config.identity_file.hash(&mut hasher);
	config.password.hash(&mut hasher);
	std::env::temp_dir().join(format!("pizza-ssh-env-{:016x}.sock", hasher.finish()))
}

pub fn control_socket_ready(config: &RemoteWorkspaceConfig, socket: &Path) -> bool {
	if !socket.exists() {
		return false;
	}
	let mut args = base_ssh_args(config);
	args.insert(0, "-S".to_string());
	args.insert(1, socket.to_string_lossy().to_string());
	args.push("-O".to_string());
	args.push("check".to_string());
	args.push(config.ssh_target.clone());
	let Ok(mut command) = ssh_command(config) else {
		return false;
	};
	command
		.args(args)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.status()
		.map(|status| status.success())
		.unwrap_or(false)
}

pub fn stop_control_master(config: &RemoteWorkspaceConfig, socket: &Path) {
	if !socket.exists() {
		return;
	}
	let mut args = base_ssh_args(config);
	args.insert(0, "-S".to_string());
	args.insert(1, socket.to_string_lossy().to_string());
	args.push("-O".to_string());
	args.push("exit".to_string());
	args.push(config.ssh_target.clone());
	let Ok(mut command) = ssh_command(config) else {
		return;
	};
	let _ = command
		.args(args)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.status();
	let _ = std::fs::remove_file(socket);
}

/// Establish one multiplexed SSH master for an environment. All probes,
/// filesystem calls, and tunnel children can then reuse the same transport.
pub fn ensure_control_master(config: &RemoteWorkspaceConfig, socket: &Path) -> Result<(), String> {
	if control_socket_ready(config, socket) {
		return Ok(());
	}
	if socket.exists() {
		let _ = std::fs::remove_file(socket);
	}
	let mut args = base_ssh_args(config);
	args.insert(0, "-M".to_string());
	args.insert(1, "-S".to_string());
	args.insert(2, socket.to_string_lossy().to_string());
	args.push("-o".to_string());
	args.push("ControlMaster=yes".to_string());
	args.push("-o".to_string());
	args.push(format!("ControlPersist={SSH_CONTROL_PERSIST_SECONDS}"));
	args.push("-fN".to_string());
	args.push(config.ssh_target.clone());

	let mut command = ssh_command(config)?;
	let output = command
		.args(args)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.output()
		.map_err(|e| format!("Failed to start SSH control master: {e}"))?;
	if !output.status.success() {
		let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
		return Err(if detail.is_empty() {
			"SSH control master failed to start".to_string()
		} else {
			format!("SSH control master failed to start: {detail}")
		});
	}
	let deadline = std::time::Instant::now() + Duration::from_secs(SSH_CONNECT_TIMEOUT_SECONDS);
	while std::time::Instant::now() < deadline {
		if control_socket_ready(config, socket) {
			return Ok(());
		}
		std::thread::sleep(Duration::from_millis(50));
	}
	Err("SSH control master did not become ready".to_string())
}

pub fn spawn_remote_agent(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
) -> Result<Child, String> {
	stop_control_master(config, control_socket);
	let _ = std::fs::remove_file(control_socket);
	let mut args = base_ssh_args(config);
	args.insert(0, "-M".to_string());
	args.insert(1, "-S".to_string());
	args.insert(2, control_socket.to_string_lossy().to_string());
	args.push("-o".to_string());
	args.push("ControlMaster=yes".to_string());
	args.push("-o".to_string());
	args.push(format!("ControlPersist={SSH_CONTROL_PERSIST_SECONDS}"));
	args.push(config.ssh_target.clone());
	args.push(remote_agent_command(config));

	let mut command = ssh_command(config)?;
	command
		.args(args)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|e| format!("Failed to start ssh: {e}"))
}

fn ssh_command_args(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	remote_command: &str,
) -> Vec<String> {
	let mut args = base_ssh_args(config);
	if control_socket_ready(config, control_socket) {
		args.insert(0, "-S".to_string());
		args.insert(1, control_socket.to_string_lossy().to_string());
	}
	args.push(config.ssh_target.clone());
	args.push(remote_command.to_string());
	args
}

fn run_ssh_output(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	remote_command: &str,
) -> Result<RemoteCommandOutput, String> {
	let mut command = ssh_command(config)?;
	let output = command
		.args(ssh_command_args(config, control_socket, remote_command))
		.stdin(Stdio::null())
		.output()
		.map_err(|e| format!("Failed to start ssh: {e}"))?;
	Ok(RemoteCommandOutput {
		stdout: String::from_utf8_lossy(&output.stdout).to_string(),
		stderr: String::from_utf8_lossy(&output.stderr).to_string(),
		success: output.status.success(),
	})
}

fn run_ssh_output_raw(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	remote_command: &str,
) -> Result<std::process::Output, String> {
	let mut command = ssh_command(config)?;
	command
		.args(ssh_command_args(config, control_socket, remote_command))
		.stdin(Stdio::null())
		.output()
		.map_err(|e| format!("Failed to start ssh: {e}"))
}

pub fn run_remote_shell(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	remote_command: &str,
) -> Result<RemoteCommandOutput, String> {
	run_ssh_output(config, control_socket, remote_command)
}

pub fn upload_file(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	remote_path: &str,
	local_path: &Path,
) -> Result<(), String> {
	let (parent, _) = remote_path
		.rsplit_once('/')
		.ok_or_else(|| "Remote upload path must be absolute".to_string())?;
	let parent = if parent.is_empty() { "/" } else { parent };
	let shell_command = format!(
		"mkdir -p {} && cat > {}",
		quote_posix_shell_arg(parent),
		quote_posix_shell_arg(remote_path),
	);
	let mut command = ssh_command(config)?;
	let mut child = command
		.args(ssh_command_args(config, control_socket, &shell_command))
		.stdin(Stdio::piped())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|e| format!("Failed to start SSH file upload: {e}"))?;
	{
		let mut stdin = child
			.stdin
			.take()
			.ok_or_else(|| "SSH file upload stdin is unavailable".to_string())?;
		let mut source =
			std::fs::File::open(local_path).map_err(|e| format!("Open local upload file: {e}"))?;
		std::io::copy(&mut source, &mut stdin)
			.map_err(|e| format!("Failed to stream SSH file upload: {e}"))?;
	}
	let output = child
		.wait_with_output()
		.map_err(|e| format!("Failed to finish SSH file upload: {e}"))?;
	if !output.status.success() {
		let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
		return Err(if detail.is_empty() {
			"Remote file upload failed".to_string()
		} else {
			format!("Remote file upload failed: {detail}")
		});
	}
	Ok(())
}

fn run_ssh_input(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	remote_command: &str,
	input: &[u8],
) -> Result<RemoteCommandOutput, String> {
	let mut command = ssh_command(config)?;
	let mut child = command
		.args(ssh_command_args(config, control_socket, remote_command))
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|e| format!("Failed to start SSH provider provisioning: {e}"))?;
	{
		let mut stdin = child
			.stdin
			.take()
			.ok_or_else(|| "SSH provider provisioning stdin is unavailable".to_string())?;
		stdin
			.write_all(input)
			.map_err(|e| format!("Failed to stream provider provisioning envelope: {e}"))?;
	}
	let output = child
		.wait_with_output()
		.map_err(|e| format!("Failed to finish SSH provider provisioning: {e}"))?;
	Ok(RemoteCommandOutput {
		stdout: String::from_utf8_lossy(&output.stdout).to_string(),
		stderr: String::from_utf8_lossy(&output.stderr).to_string(),
		success: output.status.success(),
	})
}

pub fn provision_remote_provider_config(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	local_agent_dir: &Path,
) -> Result<Value, String> {
	let envelope = build_local_provider_provisioning_envelope(local_agent_dir)?;
	let payload = serde_json::to_vec(&envelope)
		.map_err(|e| format!("Failed to serialize provider provisioning envelope: {e}"))?;
	let output = run_ssh_input(
		config,
		control_socket,
		&remote_provider_provision_command(config),
		&payload,
	)?;
	let line = output
		.stdout
		.lines()
		.rev()
		.find(|line| line.trim_start().starts_with('{'))
		.map(str::trim);
	let Some(line) = line else {
		let detail = output.stderr.trim();
		return Err(if detail.is_empty() {
			"Remote provider provisioning returned no result. Upgrade Pizza on the remote host."
				.to_string()
		} else {
			format!("Remote provider provisioning failed: {detail}")
		});
	};
	let result: Value = serde_json::from_str(line)
		.map_err(|e| format!("Remote provider provisioning returned invalid JSON: {e}"))?;
	let status = result
		.get("status")
		.and_then(Value::as_str)
		.unwrap_or("failed");
	if status == "applied" || status == "already_applied" {
		return Ok(result);
	}
	let error = result
		.get("errorMessage")
		.and_then(Value::as_str)
		.filter(|value| !value.trim().is_empty())
		.unwrap_or("Remote provider provisioning was rejected");
	Err(format!("Remote provider provisioning {status}: {error}"))
}

pub fn browse_remote_directories(
	input: RemoteSshInput,
	path: Option<String>,
) -> Result<RemoteDirectoryListing, String> {
	let config = ssh_config_from_input(input)?;
	let control_socket = control_socket_path(&config.id);
	let selected_path = path
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty());
	if let Some(value) = selected_path {
		if !value.starts_with('/') {
			return Err("Remote directory must be an absolute path".to_string());
		}
		validate_no_control_chars(value, "Remote directory")?;
	}
	let target = selected_path
		.map(quote_posix_shell_arg)
		.unwrap_or_else(|| "\"$HOME\"".to_string());
	let command = format!(
		"target={target}; cd \"$target\" || exit 1; printf '%s\\0%s\\0' \"$PWD\" \"$HOME\"; for d in */ .*/; do [ -d \"$d\" ] || continue; case \"$d\" in ./|../) continue ;; esac; printf '%s\\0' \"${{d%/}}\"; done"
	);
	let output = run_ssh_output_raw(&config, &control_socket, &command)?;
	if !output.status.success() {
		let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
		return Err(if detail.is_empty() {
			"Remote directory listing failed".to_string()
		} else {
			format!("Remote directory listing failed: {detail}")
		});
	}
	let fields: Vec<String> = output
		.stdout
		.split(|byte| *byte == 0)
		.map(|value| String::from_utf8_lossy(value).to_string())
		.collect();
	if fields.len() < 2 || fields[0].is_empty() || fields[1].is_empty() {
		return Err("Remote directory listing returned an invalid response".to_string());
	}
	let current_path = fields[0].clone();
	let home_path = fields[1].clone();
	let mut entries: Vec<RemoteDirectoryEntry> = fields
		.into_iter()
		.skip(2)
		.filter(|name| !name.is_empty())
		.map(|name| RemoteDirectoryEntry {
			path: if current_path == "/" {
				format!("/{name}")
			} else {
				format!("{current_path}/{name}")
			},
			name,
		})
		.collect();
	entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
	let parent_path = if current_path == "/" {
		None
	} else {
		Path::new(&current_path)
			.parent()
			.map(|path| path.to_string_lossy().to_string())
	};
	Ok(RemoteDirectoryListing {
		current_path,
		home_path,
		parent_path,
		entries,
	})
}

fn run_remote_pizza_version(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	command: &str,
) -> Result<RemoteCommandOutput, String> {
	let shell_command = format!(
		"cd {} || exit 1; {} --version",
		quote_posix_shell_arg(&config.remote_path),
		quote_posix_shell_arg(command),
	);
	run_ssh_output(config, control_socket, &shell_command)
}

fn first_nonempty_line(value: &str) -> Option<String> {
	value
		.lines()
		.map(str::trim)
		.find(|line| !line.is_empty())
		.map(str::to_string)
}

fn remote_pizza_version(output: &RemoteCommandOutput) -> Option<String> {
	first_nonempty_line(&output.stdout).or_else(|| first_nonempty_line(&output.stderr))
}

/// Resolve the remote Pizza executable without exposing installation details
/// to the normal connection form.
///
/// The configured command is tried first for backwards compatibility. If it is
/// missing, common package-manager and Pizza install locations are checked. The
/// returned executable is always an absolute path or a validated command name.
pub fn resolve_remote_pizza_command(
	config: &RemoteWorkspaceConfig,
) -> Result<(String, String), String> {
	let control_socket = control_socket_path(&config.id);
	if let Some(parent) = control_socket.parent() {
		let _ = std::fs::create_dir_all(parent);
	}

	if let Some(configured) = config
		.pizza_command
		.as_deref()
		.map(str::trim)
		.filter(|value| !value.is_empty())
	{
		if let Ok(output) = run_remote_pizza_version(config, &control_socket, configured) {
			if output.success {
				if let Some(version) = remote_pizza_version(&output) {
					return Ok((configured.to_string(), version));
				}
			}
		}
	}

	let output = run_ssh_output(config, &control_socket, REMOTE_PIZZA_DISCOVERY_SCRIPT)?;
	if !output.success {
		let detail = output.stderr.trim();
		if !detail.is_empty() {
			return Err(format!("Remote Pizza detection failed: {detail}"));
		}
	}
	if output.success {
		for candidate in output
			.stdout
			.lines()
			.map(str::trim)
			.filter(|line| !line.is_empty())
		{
			if validate_pizza_command(candidate).is_err() {
				continue;
			}
			if let Ok(version_output) = run_remote_pizza_version(config, &control_socket, candidate)
			{
				if version_output.success {
					if let Some(version) = remote_pizza_version(&version_output) {
						return Ok((candidate.to_string(), version));
					}
				}
			}
		}
	}

	Err(
		"Remote Pizza was not found. Checked PATH and common install locations. Install Pizza on the server or set an advanced executable path."
			.to_string(),
	)
}

pub fn add_remote_workspace(
	input: AddRemoteWorkspaceInput,
) -> Result<RemoteWorkspaceConfig, String> {
	validate_add_input(&input)?;
	let timestamp = now_millis();
	let id = uuid::Uuid::new_v4().simple().to_string();
	let config = RemoteWorkspaceConfig {
		id: id[..16].to_string(),
		label: input.label.trim().to_string(),
		ssh_target: input.ssh_target.trim().to_string(),
		port: input.port,
		identity_file: input
			.identity_file
			.map(|value| value.trim().to_string())
			.filter(|value| !value.is_empty()),
		password: input.password.filter(|value| !value.is_empty()),
		remote_path: input.remote_path.trim().to_string(),
		pizza_command: input
			.pizza_command
			.map(|value| value.trim().to_string())
			.filter(|value| !value.is_empty()),
		created_at: timestamp,
		last_accessed_at: timestamp,
	};
	let control_socket = control_socket_path(&config.id);
	let probe = format!(
		"cd {} && printf '%s\\n' \"$PWD\"",
		quote_posix_shell_arg(&config.remote_path)
	);
	let output = run_ssh_output(&config, &control_socket, &probe)?;
	if !output.success {
		let detail = output.stderr.trim();
		return Err(if detail.is_empty() {
			"Remote project directory probe failed".to_string()
		} else {
			format!("Remote project directory probe failed: {detail}")
		});
	}
	let resolved_path = output.stdout.trim();
	if resolved_path.is_empty() {
		return Err("Remote project directory returned no path".to_string());
	}
	crate::bridge::log_file(&format!(
		"remote workspace path probe ok: id={} target={} path={}",
		config.id, config.ssh_target, resolved_path
	));
	Ok(config)
}

pub fn load_remote_workspaces() -> HashMap<String, RemoteWorkspaceConfig> {
	let path = match remote_storage_path() {
		Ok(path) => path,
		Err(error) => {
			crate::bridge::log_file(&format!("remote workspace load skipped: {error}"));
			return HashMap::new();
		}
	};
	let raw = match std::fs::read_to_string(&path) {
		Ok(raw) => raw,
		Err(_) => return HashMap::new(),
	};
	let store: RemoteWorkspaceStore = match serde_json::from_str(&raw) {
		Ok(store) => store,
		Err(error) => {
			crate::bridge::log_file(&format!("remote workspace store invalid: {error}"));
			return HashMap::new();
		}
	};
	if store.version != REMOTE_STORAGE_VERSION {
		crate::bridge::log_file(&format!(
			"remote workspace store version {} is unsupported",
			store.version
		));
		return HashMap::new();
	}
	store
		.workspaces
		.into_iter()
		.filter_map(|config| {
			let key = workspace_key(&config.id);
			Some((key, config))
		})
		.collect()
}

pub fn save_remote_workspaces(
	workspaces: &HashMap<String, RemoteWorkspaceConfig>,
) -> Result<(), String> {
	let path = remote_storage_path()?;
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent)
			.map_err(|e| format!("Failed to create remote workspace directory: {e}"))?;
	}
	let mut entries: Vec<_> = workspaces.values().cloned().collect();
	entries.sort_by(|a, b| b.last_accessed_at.cmp(&a.last_accessed_at));
	let store = RemoteWorkspaceStore {
		version: REMOTE_STORAGE_VERSION,
		workspaces: entries,
	};
	let payload = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
	let temp_path = path.with_extension("json.tmp");
	{
		let mut file = std::fs::File::create(&temp_path)
			.map_err(|e| format!("Failed to write remote workspace store: {e}"))?;
		file.write_all(&payload)
			.map_err(|e| format!("Failed to write remote workspace store: {e}"))?;
		file.sync_all()
			.map_err(|e| format!("Failed to sync remote workspace store: {e}"))?;
	}
	std::fs::rename(&temp_path, &path)
		.map_err(|e| format!("Failed to replace remote workspace store: {e}"))?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
			.map_err(|e| format!("Failed to secure remote workspace store: {e}"))?;
	}
	Ok(())
}

pub fn remote_workspace_meta(config: &RemoteWorkspaceConfig) -> Value {
	json!({
		"workspace_id": format!("remote_{}", config.id),
		"cwd": workspace_key(&config.id),
		"created_at": config.created_at,
		"last_accessed_at": config.last_accessed_at,
		"dir_exists": true,
		"kind": "remote",
		"display_name": config.label,
		"remote": {
			"ssh_target": config.ssh_target,
			"port": config.port,
			"identity_file": config.identity_file,
			"has_password": config.password.as_deref().is_some_and(|value| !value.is_empty()),
			"remote_path": config.remote_path,
			"pizza_command": pizza_command(config),
		}
	})
}

pub fn run_remote_fs_request(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	request: Value,
) -> Result<Value, String> {
	let command = remote_fs_command(config, &request)?;
	let output = run_ssh_output(config, control_socket, &command)?;
	let line = output
		.stdout
		.lines()
		.rev()
		.find(|line| line.trim_start().starts_with('{'))
		.map(str::trim)
		.ok_or_else(|| {
			let detail = output.stderr.trim();
			if detail.is_empty() {
				"Remote filesystem command returned no response".to_string()
			} else {
				format!("Remote filesystem command failed: {detail}")
			}
		})?;
	let parsed: Value = serde_json::from_str(line)
		.map_err(|e| format!("Invalid remote filesystem response: {e}"))?;
	if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
		let error = parsed
			.get("error")
			.and_then(Value::as_str)
			.unwrap_or("Remote filesystem request failed");
		return Err(error.to_string());
	}
	Ok(parsed.get("data").cloned().unwrap_or(Value::Null))
}

pub fn upload_bytes(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	remote_path: &str,
	bytes: &[u8],
) -> Result<(), String> {
	let (parent, _) = remote_path
		.rsplit_once('/')
		.ok_or_else(|| "Remote upload path must be absolute".to_string())?;
	let parent = if parent.is_empty() { "/" } else { parent };
	let shell_command = format!(
		"mkdir -p {} && cat > {}",
		quote_posix_shell_arg(parent),
		quote_posix_shell_arg(remote_path),
	);
	let mut command = ssh_command(config)?;
	let mut child = command
		.args(ssh_command_args(config, control_socket, &shell_command))
		.stdin(Stdio::piped())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|e| format!("Failed to start SSH upload: {e}"))?;
	{
		let mut stdin = child
			.stdin
			.take()
			.ok_or_else(|| "SSH upload stdin is unavailable".to_string())?;
		stdin
			.write_all(bytes)
			.map_err(|e| format!("Failed to stream SSH upload: {e}"))?;
	}
	let output = child
		.wait_with_output()
		.map_err(|e| format!("Failed to finish SSH upload: {e}"))?;
	if !output.status.success() {
		let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
		return Err(if detail.is_empty() {
			"Remote upload failed".to_string()
		} else {
			format!("Remote upload failed: {detail}")
		});
	}
	Ok(())
}

pub fn allocate_local_port() -> Result<u16, String> {
	let listener = TcpListener::bind(("127.0.0.1", 0))
		.map_err(|e| format!("Failed to reserve local port: {e}"))?;
	let port = listener
		.local_addr()
		.map_err(|e| format!("Failed to read reserved local port: {e}"))?
		.port();
	drop(listener);
	Ok(port)
}

pub fn spawn_tunnel(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	local_port: u16,
	remote_port: u16,
) -> Result<Child, String> {
	let mut args = base_ssh_args(config);
	if control_socket_ready(config, control_socket) {
		args.insert(0, "-S".to_string());
		args.insert(1, control_socket.to_string_lossy().to_string());
	}
	args.push("-N".to_string());
	args.push("-L".to_string());
	args.push(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"));
	args.push(config.ssh_target.clone());

	let mut command = ssh_command(config)?;
	let child = command
		.args(args)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.map_err(|e| format!("Failed to start SSH tunnel: {e}"))?;

	let deadline = std::time::Instant::now() + FS_REQUEST_TIMEOUT;
	while std::time::Instant::now() < deadline {
		if TcpStream::connect_timeout(
			&format!("127.0.0.1:{local_port}")
				.parse()
				.map_err(|e| format!("Invalid local tunnel address: {e}"))?,
			Duration::from_millis(250),
		)
		.is_ok()
		{
			return Ok(child);
		}
		std::thread::sleep(Duration::from_millis(50));
	}
	let mut child = child;
	let _ = child.kill();
	let _ = child.wait();
	Err(format!(
		"SSH tunnel to remote port {remote_port} did not become ready"
	))
}

#[cfg(unix)]
pub fn spawn_unix_socket_tunnel(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	local_socket: &Path,
	remote_socket: &str,
) -> Result<Child, String> {
	let _ = std::fs::remove_file(local_socket);
	let mut args = base_ssh_args(config);
	if control_socket_ready(config, control_socket) {
		args.insert(0, "-S".to_string());
		args.insert(1, control_socket.to_string_lossy().to_string());
	}
	args.push("-o".to_string());
	args.push("ExitOnForwardFailure=yes".to_string());
	args.push("-N".to_string());
	args.push("-L".to_string());
	args.push(format!(
		"{}:{}",
		local_socket.to_string_lossy(),
		remote_socket
	));
	args.push(config.ssh_target.clone());

	let mut command = ssh_command(config)?;
	let mut child = command
		.args(args)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|e| format!("Failed to start remote gateway tunnel: {e}"))?;
	let deadline = std::time::Instant::now() + FS_REQUEST_TIMEOUT;
	while std::time::Instant::now() < deadline {
		if child
			.try_wait()
			.map_err(|e| format!("Failed to inspect remote gateway tunnel: {e}"))?
			.is_some()
		{
			let mut stderr = Vec::new();
			if let Some(mut pipe) = child.stderr.take() {
				let _ = pipe.read_to_end(&mut stderr);
			}
			let detail = String::from_utf8_lossy(&stderr).trim().to_string();
			return Err(if detail.is_empty() {
				"Remote gateway tunnel exited before becoming ready".to_string()
			} else {
				format!("Remote gateway tunnel failed: {detail}")
			});
		}
		if std::os::unix::net::UnixStream::connect(local_socket).is_ok() {
			return Ok(child);
		}
		std::thread::sleep(Duration::from_millis(50));
	}
	let _ = child.kill();
	let _ = child.wait();
	Err("Remote gateway tunnel did not become ready".to_string())
}

#[cfg(not(unix))]
pub fn spawn_unix_socket_tunnel(
	_config: &RemoteWorkspaceConfig,
	_control_socket: &Path,
	_local_socket: &Path,
	_remote_socket: &str,
) -> Result<Child, String> {
	Err(
		"Remote gateway socket forwarding is not supported on this desktop platform yet"
			.to_string(),
	)
}

pub fn local_gateway_socket_path(id: &str) -> PathBuf {
	std::env::temp_dir().join(format!("pizza-remote-gateway-{id}.sock"))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn valid_input() -> AddRemoteWorkspaceInput {
		AddRemoteWorkspaceInput {
			label: "Build host".to_string(),
			ssh_target: "dev@example.com".to_string(),
			port: Some(2222),
			identity_file: Some("~/.ssh/id_ed25519".to_string()),
			password: None,
			remote_path: "/srv/project with spaces".to_string(),
			pizza_command: Some("pizza".to_string()),
		}
	}

	#[test]
	fn shell_quoting_handles_single_quotes() {
		assert_eq!(quote_posix_shell_arg("a'b"), "'a'\"'\"'b'");
	}

	#[test]
	fn remote_agent_command_quotes_project_and_executable() {
		validate_add_input(&valid_input()).unwrap();
		let config = RemoteWorkspaceConfig {
			id: "abc".to_string(),
			label: "Build host".to_string(),
			ssh_target: "dev@example.com".to_string(),
			port: Some(2222),
			identity_file: None,
			password: None,
			remote_path: "/srv/project with spaces".to_string(),
			pizza_command: Some("/opt/pizza bin/pizza".to_string()),
			created_at: 1,
			last_accessed_at: 1,
		};
		assert_eq!(
			remote_agent_command(&config),
			"cd '/srv/project with spaces' || exit 1; exec '/opt/pizza bin/pizza' --mode rpc"
		);
	}

	#[test]
	fn rejects_shell_syntax_in_pizza_command() {
		let mut input = valid_input();
		input.pizza_command = Some("pizza; rm -rf /".to_string());
		assert!(validate_add_input(&input).is_err());
	}

	#[test]
	fn rejects_relative_remote_paths() {
		let mut input = valid_input();
		input.remote_path = "srv/project".to_string();
		assert!(validate_add_input(&input).is_err());
	}

	#[test]
	fn workspace_key_round_trips() {
		let key = workspace_key("abc123");
		assert_eq!(key, "remote://abc123");
		assert_eq!(workspace_id_from_key(&key), Some("abc123"));
		assert!(is_remote_workspace_key(&key));
	}

	#[test]
	fn environment_control_socket_is_shared_by_project_directories() {
		let base = RemoteWorkspaceConfig {
			id: "first".to_string(),
			label: "First".to_string(),
			ssh_target: "root@example.com".to_string(),
			port: None,
			identity_file: Some("~/.ssh/id_ed25519".to_string()),
			password: None,
			remote_path: "/root/one".to_string(),
			pizza_command: None,
			created_at: 0,
			last_accessed_at: 0,
		};
		let mut sibling = base.clone();
		sibling.id = "second".to_string();
		sibling.remote_path = "/root/two".to_string();
		assert_eq!(
			environment_control_socket_path(&base),
			environment_control_socket_path(&sibling)
		);

		let mut different_host = sibling;
		different_host.ssh_target = "root@other.example.com".to_string();
		assert_ne!(
			environment_control_socket_path(&base),
			environment_control_socket_path(&different_host)
		);
	}

	#[test]
	fn metadata_marks_workspace_as_remote() {
		let config = RemoteWorkspaceConfig {
			id: "abc".to_string(),
			label: "Build host".to_string(),
			ssh_target: "dev@example.com".to_string(),
			port: None,
			identity_file: None,
			password: None,
			remote_path: "/srv/project".to_string(),
			pizza_command: None,
			created_at: 10,
			last_accessed_at: 20,
		};
		let meta = remote_workspace_meta(&config);
		assert_eq!(meta["kind"], "remote");
		assert_eq!(meta["cwd"], "remote://abc");
		assert_eq!(meta["display_name"], "Build host");
		assert_eq!(meta["remote"]["remote_path"], "/srv/project");
	}

	#[cfg(unix)]
	#[test]
	fn probe_and_fs_request_use_the_configured_ssh_program() {
		use std::io::{BufRead, BufReader, Write};
		use std::os::unix::fs::PermissionsExt;

		let root = std::env::temp_dir().join(format!("pizza-remote-test-{}", uuid::Uuid::new_v4()));
		std::fs::create_dir_all(&root).unwrap();
		let script = root.join("fake-ssh");
		let mut file = std::fs::File::create(&script).unwrap();
		file.write_all(
			b"#!/bin/sh\nlast=''\nfor arg in \"$@\"; do last=\"$arg\"; done\ncase \"$last\" in\n  *command*v*pizza*) printf '/root/.pizza/bin/pizza\\n' ;;\n  *pizza/bin/pizza*--version*) printf '0.4.1\\n' >&2 ;;\n  *--version*) printf '0.4.1\\n' >&2 ;;\n  *provider-provision-rpc*) if [ -n \"$FAKE_SSH_STDIN_PATH\" ]; then cat > \"$FAKE_SSH_STDIN_PATH\"; else cat >/dev/null; fi; printf '%s\\n' '{\"syncId\":\"test\",\"status\":\"applied\",\"personalProviderCount\":1,\"credentialCount\":1,\"rolledBack\":false}' ;;\n  *fs-rpc*) printf '%s\\n' '{\"ok\":true,\"data\":[{\"name\":\"remote-file\"}]}' ;;\n  *--mode\\ rpc*) IFS= read -r line; printf '%s\\n' '{\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{}}' ;;\n  *) exit 1 ;;\nesac\n",
		)
		.unwrap();
		drop(file);
		std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

		let previous = std::env::var_os("PIZZA_SSH_BIN");
		std::env::set_var("PIZZA_SSH_BIN", &script);
		let captured_stdin = root.join("provider-envelope.json");
		let previous_stdin = std::env::var_os("FAKE_SSH_STDIN_PATH");
		std::env::set_var("FAKE_SSH_STDIN_PATH", &captured_stdin);
		let config = RemoteWorkspaceConfig {
			id: "fake".to_string(),
			label: "Fake".to_string(),
			ssh_target: "example.com".to_string(),
			port: None,
			identity_file: None,
			password: None,
			remote_path: "/srv/project".to_string(),
			pizza_command: None,
			created_at: 1,
			last_accessed_at: 1,
		};

		assert_eq!(resolve_remote_pizza_command(&config).unwrap().1, "0.4.1");
		assert_eq!(
			resolve_remote_pizza_command(&config).unwrap().0,
			"/root/.pizza/bin/pizza"
		);
		let data = run_remote_fs_request(
			&config,
			&control_socket_path("fake"),
			json!({"id": "1", "method": "list_dir"}),
		)
		.unwrap();
		assert_eq!(data[0]["name"], "remote-file");

		let local_agent_dir = root.join("local-agent");
		std::fs::create_dir_all(&local_agent_dir).unwrap();
		std::fs::write(
			local_agent_dir.join("auth.json"),
			r#"{"custom-provider":{"type":"api_key","key":"test-secret"}}"#,
		)
		.unwrap();
		std::fs::write(
			local_agent_dir.join("models.json"),
			r#"{"providers":{"custom-provider":{"name":"Custom","api":"openai-completions","baseUrl":"https://example.test/v1","models":[{"id":"model-a"}]}}}"#,
		)
		.unwrap();
		std::fs::write(
			local_agent_dir.join("settings.json"),
			r#"{"theme":"test-theme","defaultProvider":"custom-provider","defaultModel":"model-a"}"#,
		)
		.unwrap();
		let provisioned = provision_remote_provider_config(
			&config,
			&control_socket_path("fake"),
			&local_agent_dir,
		)
		.unwrap();
		assert_eq!(provisioned["status"], "applied");
		let envelope: Value =
			serde_json::from_slice(&std::fs::read(&captured_stdin).unwrap()).unwrap();
		assert_eq!(
			envelope["models"]["providers"]["custom-provider"]["name"],
			"Custom"
		);
		assert_eq!(envelope["settings"]["defaultModel"], "model-a");
		assert_eq!(
			envelope["credentials"]["entries"]["custom-provider"]["type"],
			"api_key"
		);

		let mut child = spawn_remote_agent(&config, &control_socket_path("fake")).unwrap();
		child
			.stdin
			.as_mut()
			.unwrap()
			.write_all(b"{\"id\":\"1\",\"type\":\"get_state\"}\n")
			.unwrap();
		let stdout = child.stdout.take().unwrap();
		let mut reader = BufReader::new(stdout);
		let mut response = String::new();
		reader.read_line(&mut response).unwrap();
		assert!(response.contains("\"command\":\"get_state\""));
		let _ = child.kill();
		let _ = child.wait();

		match previous {
			Some(value) => std::env::set_var("PIZZA_SSH_BIN", value),
			None => std::env::remove_var("PIZZA_SSH_BIN"),
		}
		match previous_stdin {
			Some(value) => std::env::set_var("FAKE_SSH_STDIN_PATH", value),
			None => std::env::remove_var("FAKE_SSH_STDIN_PATH"),
		}
		let _ = std::fs::remove_dir_all(root);
	}
}
