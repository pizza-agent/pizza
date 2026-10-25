/**
 * Versioned remote Pizza server installation and daemon lifecycle.
 *
 * Probe first, install into an immutable version directory under a remote
 * lock, verify the executable, switch the launcher atomically, then start or
 * reuse a per-user daemon. The server archive is self-contained (production
 * node_modules included), so the remote host never runs npm. The private Node
 * runtime is pinned by checksum; when the remote host cannot download it, the
 * desktop downloads it and uploads it over SSH.
 */
use crate::remote::{
	self, quote_posix_shell_arg, run_remote_shell, upload_file, RemoteWorkspaceConfig,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Child;

const MANIFEST_SCHEMA_VERSION: u64 = 2;
const DEFAULT_NODE_MIRROR: &str = "https://nodejs.org/dist";
const NODE_DOWNLOAD_FAILED_MARKER: &str = "PIZZA_NODE_DOWNLOAD_FAILED";

#[derive(Clone, Debug)]
pub struct RemoteServerInstall {
	pub version: String,
	pub pizza_command: String,
	pub gateway_socket: String,
	pub service_mode: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestNodeRuntime {
	version: String,
	sha256: HashMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
	version: String,
	archive: String,
	sha256: String,
	node_runtime: ManifestNodeRuntime,
}

#[derive(Clone, Debug)]
pub struct RemoteServerManifest {
	pub version: String,
	pub archive: String,
	pub sha256: String,
	pub node_version: String,
	node_sha256: HashMap<String, String>,
}

impl RemoteServerManifest {
	fn node_sha256(&self, node_arch: &str) -> Result<&str, String> {
		self.node_sha256
			.get(node_arch)
			.map(String::as_str)
			.ok_or_else(|| format!("Remote server manifest has no Node runtime for {node_arch}"))
	}
}

#[derive(Debug)]
struct RemoteRuntimeProbe {
	home: String,
	platform: String,
	arch: String,
	managed_version: String,
	managed_command_ok: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum InstallDecision {
	/// The managed server already runs the bundled version.
	Reuse,
	/// The host runs a newer server (installed by a newer desktop). Never
	/// downgrade it: that would restart the daemon under the other client.
	KeepNewer,
	Install,
}

fn parse_prefixed_lines(output: &str) -> HashMap<String, String> {
	output
		.lines()
		.filter_map(|line| {
			let (key, value) = line.split_once('=')?;
			Some((key.trim().to_string(), value.trim().to_string()))
		})
		.collect()
}

fn validate_version(version: &str) -> Result<(), String> {
	if version.is_empty()
		|| version.len() > 64
		|| !version
			.chars()
			.all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
	{
		return Err("Remote server version contains invalid characters".to_string());
	}
	Ok(())
}

fn validate_sha256(sha256: &str) -> Result<(), String> {
	if sha256.len() != 64 || !sha256.chars().all(|character| character.is_ascii_hexdigit()) {
		return Err("Remote server archive SHA-256 is invalid".to_string());
	}
	Ok(())
}

/// `major.minor.patch[-pre]` → comparable key. Releases sort above their
/// pre-releases. Returns None for anything else.
fn version_key(version: &str) -> Option<(u64, u64, u64, bool)> {
	let (core, pre) = match version.split_once('-') {
		Some((core, pre)) => (core, Some(pre)),
		None => (version, None),
	};
	let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
	let key = (parts.next()??, parts.next()??, parts.next()??, pre.is_none());
	parts.next().is_none().then_some(key)
}

fn version_is_newer(candidate: &str, baseline: &str) -> bool {
	matches!((version_key(candidate), version_key(baseline)), (Some(a), Some(b)) if a > b)
}

fn install_decision(managed_version: &str, managed_ok: bool, bundled: &str) -> InstallDecision {
	if !managed_ok {
		InstallDecision::Install
	} else if managed_version == bundled {
		InstallDecision::Reuse
	} else if version_is_newer(managed_version, bundled) {
		InstallDecision::KeepNewer
	} else {
		InstallDecision::Install
	}
}

fn node_mirror() -> Result<String, String> {
	let mirror = std::env::var("PIZZA_REMOTE_NODE_MIRROR")
		.ok()
		.map(|value| value.trim().trim_end_matches('/').to_string())
		.filter(|value| !value.is_empty())
		.unwrap_or_else(|| DEFAULT_NODE_MIRROR.to_string());
	if !(mirror.starts_with("https://") || mirror.starts_with("http://"))
		|| mirror.chars().any(|c| c.is_whitespace() || c.is_control())
	{
		return Err(format!("PIZZA_REMOTE_NODE_MIRROR is not a valid URL: {mirror}"));
	}
	Ok(mirror)
}

/// `NAME='value'` lines prepended to a static script body, so the body needs
/// no format-string escaping and every value is shell-quoted.
fn script_with_vars(vars: &[(&str, &str)], body: &str) -> String {
	let mut script = String::from("set -eu\n");
	for (name, value) in vars {
		script.push_str(&format!("{name}={}\n", quote_posix_shell_arg(value)));
	}
	script.push_str(body);
	script
}

fn probe_remote_runtime(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
) -> Result<RemoteRuntimeProbe, String> {
	let command = r#"
printf 'HOME=%s\n' "$HOME"
printf 'PLATFORM=%s\n' "$(uname -s | tr '[:upper:]' '[:lower:]')"
printf 'ARCH=%s\n' "$(uname -m)"
printf 'MANAGED_VERSION=%s\n' "$(cat "$HOME/.pizza/server/current-version" 2>/dev/null || true)"
if [ -x "$HOME/.pizza/bin/pizza" ] && "$HOME/.pizza/bin/pizza" --version >/dev/null 2>&1; then
  printf 'MANAGED_COMMAND_OK=1\n'
else
  printf 'MANAGED_COMMAND_OK=0\n'
fi
"#;
	let output = run_remote_shell(config, control_socket, command)?;
	if !output.success {
		return Err(format!(
			"Remote environment probe failed: {}",
			output.stderr.trim()
		));
	}
	let values = parse_prefixed_lines(&output.stdout);
	let home = values
		.get("HOME")
		.filter(|value| value.starts_with('/'))
		.cloned()
		.ok_or_else(|| "Remote HOME is unavailable".to_string())?;
	let platform = values
		.get("PLATFORM")
		.cloned()
		.ok_or_else(|| "Remote platform is unavailable".to_string())?;
	let arch = values
		.get("ARCH")
		.cloned()
		.ok_or_else(|| "Remote CPU architecture is unavailable".to_string())?;
	if platform != "linux" && platform != "darwin" {
		return Err(format!(
			"Remote server installation currently supports Linux and macOS, not {platform}"
		));
	}
	Ok(RemoteRuntimeProbe {
		home,
		platform,
		arch,
		managed_version: values.get("MANAGED_VERSION").cloned().unwrap_or_default(),
		managed_command_ok: values
			.get("MANAGED_COMMAND_OK")
			.map(|value| value == "1")
			.unwrap_or(false),
	})
}

fn node_archive_arch(probe: &RemoteRuntimeProbe) -> Result<&'static str, String> {
	match (probe.platform.as_str(), probe.arch.as_str()) {
		("linux", "x86_64" | "amd64") => Ok("linux-x64"),
		("linux", "aarch64" | "arm64") => Ok("linux-arm64"),
		("darwin", "x86_64" | "amd64") => Ok("darwin-x64"),
		("darwin", "aarch64" | "arm64") => Ok("darwin-arm64"),
		_ => Err(format!(
			"Remote Pizza does not support platform={} arch={}",
			probe.platform, probe.arch
		)),
	}
}

const SERVICE_SCRIPT_BODY: &str = r#"
SOCKET="$HOME/.pizza/gateway.sock"
gateway_ready() { "$PIZZA" gateway status >/dev/null 2>&1; }

if [ "$RESTART" = "1" ]; then
  # Let in-flight agent turns finish before replacing the daemon.
  "$PIZZA" gateway stop --drain >/dev/null 2>&1 || true
fi

SERVICE_MODE=detached
if [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  # User services are removed when the last login session ends unless
  # lingering is enabled. Keep the remote gateway alive after SSH disconnects.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  fi
  SERVICE_DIR="$HOME/.config/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/pizza-remote.service"
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_FILE.tmp" <<'PIZZA_SERVICE'
[Unit]
Description=Pizza Remote Server
After=network.target

[Service]
Type=simple
ExecStart=%h/.pizza/bin/pizza --mode gateway
Environment=PIZZA_CODING_AGENT_DIR=%h/.pizza/agent
Environment=PIZZA_GATEWAY_SOCKET=%h/.pizza/gateway.sock
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
PIZZA_SERVICE
  mv "$SERVICE_FILE.tmp" "$SERVICE_FILE"
  systemctl --user daemon-reload
  systemctl --user enable pizza-remote.service >/dev/null 2>&1 || true
  if [ "$RESTART" = "1" ]; then
    systemctl --user restart pizza-remote.service
  else
    systemctl --user start pizza-remote.service
  fi
  SERVICE_MODE=systemd
elif ! gateway_ready; then
  "$PIZZA" gateway start >/dev/null 2>&1 || true
fi

# A socket file alone is not proof of life (it survives crashes); require the
# daemon to answer a status request.
i=0
while [ "$i" -lt 150 ]; do
  if gateway_ready; then
    printf 'SERVICE_MODE=%s\n' "$SERVICE_MODE"
    printf 'GATEWAY_SOCKET=%s\n' "$SOCKET"
    exit 0
  fi
  i=$((i + 1))
  sleep 0.2
done
echo "Pizza gateway did not become ready" >&2
exit 1
"#;

fn service_setup_script(pizza_command: &str, restart: bool) -> String {
	script_with_vars(
		&[
			("PIZZA", pizza_command),
			("RESTART", if restart { "1" } else { "0" }),
		],
		SERVICE_SCRIPT_BODY,
	)
}

fn ensure_service(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	pizza_command: &str,
	restart: bool,
) -> Result<String, String> {
	let output = run_remote_shell(
		config,
		control_socket,
		&service_setup_script(pizza_command, restart),
	)?;
	if !output.success {
		let detail = output.stderr.trim();
		return Err(if detail.is_empty() {
			"Remote Pizza daemon failed to start".to_string()
		} else {
			format!("Remote Pizza daemon failed to start: {detail}")
		});
	}
	Ok(parse_prefixed_lines(&output.stdout)
		.get("SERVICE_MODE")
		.cloned()
		.unwrap_or_else(|| "detached".to_string()))
}

fn managed_gateway_socket(home: &str) -> String {
	format!("{}/.pizza/gateway.sock", home.trim_end_matches('/'))
}

/// Probe only the facts needed for a fast reconnect to an already-installed
/// server. Any failure falls back to the full install/start path.
pub fn probe_managed_gateway(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	expected_version: &str,
) -> Result<Option<String>, String> {
	validate_version(expected_version)?;
	let command = r#"
printf 'HOME=%s\n' "$HOME"
printf 'VERSION=%s\n' "$(cat "$HOME/.pizza/server/current-version" 2>/dev/null || true)"
if [ -x "$HOME/.pizza/bin/pizza" ] && [ -S "$HOME/.pizza/gateway.sock" ]; then
  printf 'READY=1\n'
else
  printf 'READY=0\n'
fi
"#;
	let output = run_remote_shell(config, control_socket, command)?;
	if !output.success {
		return Err(format!(
			"Managed gateway probe failed: {}",
			output.stderr.trim()
		));
	}
	let values = parse_prefixed_lines(&output.stdout);
	let home = values
		.get("HOME")
		.filter(|value| value.starts_with('/'))
		.ok_or_else(|| "Managed gateway probe returned no HOME".to_string())?;
	let version = values.get("VERSION").map(String::as_str).unwrap_or_default();
	let decision = install_decision(version, true, expected_version);
	if values.get("READY").map(String::as_str) != Some("1")
		|| decision == InstallDecision::Install
	{
		return Ok(None);
	}
	Ok(Some(managed_gateway_socket(home)))
}

const INSTALL_SCRIPT_BODY: &str = r#"
umask 077
PIZZA_ROOT="$HOME/.pizza"
SERVER_ROOT="$PIZZA_ROOT/server"
RUNTIME_ROOT="$PIZZA_ROOT/runtime"
BOOTSTRAP="$PIZZA_ROOT/bootstrap"
NODE_NAME="node-v$NODE_VERSION-$NODE_ARCH"
NODE_ROOT="$RUNTIME_ROOT/$NODE_NAME"
INSTALL_ROOT="$SERVER_ROOT/versions/$VERSION"
WRAPPER="$PIZZA_ROOT/bin/pizza"
LOCK="$SERVER_ROOT/.install.lock"

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  echo "sha256sum or shasum is required to verify the Pizza server" >&2
  exit 1
fi

mkdir -p "$SERVER_ROOT/versions" "$RUNTIME_ROOT" "$BOOTSTRAP" "$PIZZA_ROOT/bin"

# Serialize installs from concurrent desktop windows or machines. A lock left
# by a killed installer is reclaimed after 15 minutes.
waited=0
while ! mkdir "$LOCK" 2>/dev/null; do
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
    rm -rf "$LOCK"
    continue
  fi
  waited=$((waited + 1))
  if [ "$waited" -ge 600 ]; then
    echo "Timed out waiting for another Pizza installation to finish" >&2
    exit 1
  fi
  sleep 1
done
trap 'rm -rf "$LOCK"' EXIT INT TERM

# Another installer may have completed this version while we waited.
if [ "$(cat "$SERVER_ROOT/current-version" 2>/dev/null || true)" = "$VERSION" ] \
  && [ -x "$WRAPPER" ] && "$WRAPPER" --version >/dev/null 2>&1; then
  printf 'INSTALL_ROOT=%s\n' "$INSTALL_ROOT"
  printf 'PIZZA_COMMAND=%s\n' "$WRAPPER"
  exit 0
fi

[ "$(sha256_of "$ARCHIVE")" = "$EXPECTED_SHA256" ] || {
  echo "Pizza server archive checksum mismatch" >&2
  exit 1
}

if [ ! -x "$NODE_ROOT/bin/node" ]; then
  node_archive="$BOOTSTRAP/$NODE_NAME.tar.gz"
  if [ ! -f "$node_archive" ] || [ "$(sha256_of "$node_archive")" != "$NODE_SHA256" ]; then
    rm -f "$node_archive" "$node_archive.part"
    url="$NODE_MIRROR/v$NODE_VERSION/$NODE_NAME.tar.gz"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --connect-timeout 15 --max-time 600 -o "$node_archive.part" "$url" || true
    elif command -v wget >/dev/null 2>&1; then
      wget -q -T 30 -O "$node_archive.part" "$url" || true
    fi
    if [ -s "$node_archive.part" ] && [ "$(sha256_of "$node_archive.part")" = "$NODE_SHA256" ]; then
      mv "$node_archive.part" "$node_archive"
    else
      rm -f "$node_archive.part"
      echo "PIZZA_NODE_DOWNLOAD_FAILED" >&2
      exit 42
    fi
  fi
  extract="$RUNTIME_ROOT/.extract-$$"
  rm -rf "$extract"
  mkdir -p "$extract"
  tar --no-same-owner -xzf "$node_archive" -C "$extract"
  rm -rf "$NODE_ROOT"
  mv "$extract/$NODE_NAME" "$NODE_ROOT"
  rm -rf "$extract"
fi

STAGING="$SERVER_ROOT/.staging-$VERSION-$$"
rm -rf "$STAGING"
mkdir -p "$STAGING"
tar --no-same-owner -xzf "$ARCHIVE" -C "$STAGING"
version_output="$("$NODE_ROOT/bin/node" "$STAGING/package/dist/src/cli.js" --version 2>&1 | head -n 1)"
[ "$version_output" = "$VERSION" ] || {
  echo "Installed Pizza version mismatch: $version_output" >&2
  exit 1
}

previous_version="$(cat "$SERVER_ROOT/current-version" 2>/dev/null || true)"
previous_wrapper="$(cat "$WRAPPER" 2>/dev/null || true)"
rm -rf "$INSTALL_ROOT"
mv "$STAGING/package" "$INSTALL_ROOT"
rm -rf "$STAGING"

cat > "$WRAPPER.tmp-$$" <<PIZZA_WRAPPER
#!/bin/sh
export PATH="$NODE_ROOT/bin:\$PATH"
exec "$NODE_ROOT/bin/node" "$INSTALL_ROOT/dist/src/cli.js" "\$@"
PIZZA_WRAPPER
chmod 700 "$WRAPPER.tmp-$$"
mv "$WRAPPER.tmp-$$" "$WRAPPER"
printf '%s\n' "$VERSION" > "$SERVER_ROOT/current-version.tmp"
mv "$SERVER_ROOT/current-version.tmp" "$SERVER_ROOT/current-version"
cat > "$SERVER_ROOT/install.json" <<PIZZA_INSTALL
{"schemaVersion":2,"version":"$VERSION","nodeVersion":"$NODE_VERSION","nodeArch":"$NODE_ARCH","installRoot":"$INSTALL_ROOT","updatedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
PIZZA_INSTALL

# Keep the new version plus the previous one (its daemon keeps running from
# that tree until the restart that follows); drop everything older.
for dir in "$SERVER_ROOT/versions"/*; do
  [ -e "$dir" ] || continue
  name="${dir##*/}"
  if [ "$name" != "$VERSION" ] && [ "$name" != "$previous_version" ]; then
    rm -rf "$dir"
  fi
done
for dir in "$RUNTIME_ROOT"/node-v*; do
  [ -e "$dir" ] || continue
  [ "$dir" = "$NODE_ROOT" ] && continue
  case "$previous_wrapper" in
    *"$dir/"*) ;;
    *) rm -rf "$dir" ;;
  esac
done
rm -rf "$SERVER_ROOT"/.staging-* "$RUNTIME_ROOT"/.extract-*
rm -f "$PIZZA_ROOT/bin"/pizza.backup-* "$PIZZA_ROOT/bin"/pizza.tmp-*
rm -f "$BOOTSTRAP"/pizza-server-*.tgz "$BOOTSTRAP"/node-v*.tar.gz "$BOOTSTRAP"/*.part "$BOOTSTRAP"/SHASUMS256-*.txt

printf 'INSTALL_ROOT=%s\n' "$INSTALL_ROOT"
printf 'PIZZA_COMMAND=%s\n' "$WRAPPER"
"#;

struct InstallParams<'a> {
	home: &'a str,
	version: &'a str,
	expected_sha256: &'a str,
	archive: &'a str,
	node_version: &'a str,
	node_arch: &'a str,
	node_sha256: &'a str,
	node_mirror: &'a str,
}

fn install_script(params: &InstallParams) -> String {
	script_with_vars(
		&[
			("HOME", params.home),
			("VERSION", params.version),
			("EXPECTED_SHA256", params.expected_sha256),
			("ARCHIVE", params.archive),
			("NODE_VERSION", params.node_version),
			("NODE_ARCH", params.node_arch),
			("NODE_SHA256", params.node_sha256),
			("NODE_MIRROR", params.node_mirror),
		],
		INSTALL_SCRIPT_BODY,
	)
}

fn local_cache_dir() -> Result<PathBuf, String> {
	let home = std::env::var_os("HOME")
		.or_else(|| std::env::var_os("USERPROFILE"))
		.map(PathBuf::from)
		.ok_or_else(|| "could not determine home directory".to_string())?;
	Ok(home.join(".pizza").join("desktop").join("remote-cache"))
}

fn sha256_hex_file(path: &Path) -> Result<String, String> {
	let mut file = std::fs::File::open(path).map_err(|e| format!("Open {}: {e}", path.display()))?;
	let mut hasher = Sha256::new();
	let mut buffer = [0u8; 64 * 1024];
	loop {
		let read = file
			.read(&mut buffer)
			.map_err(|e| format!("Read {}: {e}", path.display()))?;
		if read == 0 {
			break;
		}
		hasher.update(&buffer[..read]);
	}
	Ok(format!("{:x}", hasher.finalize()))
}

/// Download the pinned Node runtime on the desktop (which usually has better
/// connectivity or proxy settings than the server) and cache it.
/// Must run on a blocking thread, not inside an async task.
fn local_node_archive(node_version: &str, node_arch: &str, expected: &str) -> Result<PathBuf, String> {
	let name = format!("node-v{node_version}-{node_arch}.tar.gz");
	let dir = local_cache_dir()?;
	let path = dir.join(&name);
	if path.exists() && sha256_hex_file(&path)? == expected {
		return Ok(path);
	}
	std::fs::create_dir_all(&dir).map_err(|e| format!("Create {}: {e}", dir.display()))?;
	let url = format!("{}/v{node_version}/{name}", node_mirror()?);
	crate::bridge::log_file(&format!("remote deploy: downloading Node runtime locally from {url}"));
	let bytes = tauri::async_runtime::block_on(async {
		reqwest::get(&url)
			.await
			.and_then(|response| response.error_for_status())
			.map_err(|e| e.to_string())?
			.bytes()
			.await
			.map_err(|e| e.to_string())
	})
	.map_err(|e| format!("Download Node runtime {url}: {e}"))?;
	let actual = format!("{:x}", Sha256::digest(&bytes));
	if actual != expected {
		return Err(format!("Node runtime checksum mismatch for {url}"));
	}
	let partial = dir.join(format!("{name}.part"));
	std::fs::write(&partial, &bytes).map_err(|e| format!("Write {}: {e}", partial.display()))?;
	std::fs::rename(&partial, &path).map_err(|e| format!("Write {}: {e}", path.display()))?;
	Ok(path)
}

fn run_install(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	script: &str,
) -> Result<Result<(), String>, String> {
	let output = run_remote_shell(config, control_socket, script)?;
	if output.success {
		return Ok(Ok(()));
	}
	let detail = output.stderr.trim().to_string();
	if detail.contains(NODE_DOWNLOAD_FAILED_MARKER) {
		return Ok(Err(detail));
	}
	Err(if detail.is_empty() {
		"Remote Pizza server installation failed".to_string()
	} else {
		format!("Remote Pizza server installation failed: {detail}")
	})
}

/// Install (if needed) and start the managed remote server. Blocking: call
/// from a blocking thread.
pub fn ensure_remote_server(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	asset_dir: &Path,
	manifest: &RemoteServerManifest,
) -> Result<RemoteServerInstall, String> {
	let probe = probe_remote_runtime(config, control_socket)?;
	let node_arch = node_archive_arch(&probe)?;
	let home = probe.home.trim_end_matches('/');
	let pizza_command = format!("{home}/.pizza/bin/pizza");
	let gateway_socket = managed_gateway_socket(home);

	let decision = install_decision(
		&probe.managed_version,
		probe.managed_command_ok,
		&manifest.version,
	);
	let version = match decision {
		InstallDecision::Reuse => manifest.version.clone(),
		InstallDecision::KeepNewer => {
			crate::bridge::log_file(&format!(
				"remote deploy: keeping newer remote server {} (bundled {})",
				probe.managed_version, manifest.version
			));
			probe.managed_version.clone()
		}
		InstallDecision::Install => {
			let archive_path = asset_dir.join(&manifest.archive);
			if !archive_path.exists() {
				return Err(format!(
					"Pizza remote server archive is missing: {}",
					archive_path.display()
				));
			}
			let remote_archive = format!("{home}/.pizza/bootstrap/{}", manifest.archive);
			upload_file(config, control_socket, &remote_archive, &archive_path)?;
			let node_sha256 = manifest.node_sha256(node_arch)?;
			let mirror = node_mirror()?;
			let script = install_script(&InstallParams {
				home,
				version: &manifest.version,
				expected_sha256: &manifest.sha256,
				archive: &remote_archive,
				node_version: &manifest.node_version,
				node_arch,
				node_sha256,
				node_mirror: &mirror,
			});
			if let Err(detail) = run_install(config, control_socket, &script)? {
				crate::bridge::log_file(&format!(
					"remote deploy: remote Node download failed, uploading from desktop: {detail}"
				));
				let local = local_node_archive(&manifest.node_version, node_arch, node_sha256)?;
				let remote_node = format!(
					"{home}/.pizza/bootstrap/node-v{}-{node_arch}.tar.gz",
					manifest.node_version
				);
				upload_file(config, control_socket, &remote_node, &local)?;
				run_install(config, control_socket, &script)?.map_err(|detail| {
					format!("Remote Pizza server installation failed: {detail}")
				})?;
			}
			manifest.version.clone()
		}
	};

	let service_mode = ensure_service(
		config,
		control_socket,
		&pizza_command,
		decision == InstallDecision::Install,
	)?;
	Ok(RemoteServerInstall {
		version,
		pizza_command,
		gateway_socket,
		service_mode,
	})
}

pub fn open_gateway_channel(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	install: &RemoteServerInstall,
) -> Result<(PathBuf, Child), String> {
	let local_socket = remote::local_gateway_socket_path(&config.id);
	let child = remote::spawn_unix_socket_tunnel(
		config,
		control_socket,
		&local_socket,
		&install.gateway_socket,
	)?;
	Ok((local_socket, child))
}

pub fn remote_server_manifest(manifest_path: &Path) -> Result<RemoteServerManifest, String> {
	let raw = std::fs::read_to_string(manifest_path)
		.map_err(|e| format!("Failed to read remote server manifest: {e}"))?;
	parse_remote_server_manifest(&raw)
}

fn parse_remote_server_manifest(raw: &str) -> Result<RemoteServerManifest, String> {
	let probe: serde_json::Value =
		serde_json::from_str(raw).map_err(|e| format!("Invalid remote server manifest: {e}"))?;
	if probe.get("schemaVersion").and_then(serde_json::Value::as_u64) != Some(MANIFEST_SCHEMA_VERSION) {
		return Err("Unsupported remote server manifest schema. Rebuild the desktop application.".to_string());
	}
	let parsed: RawManifest =
		serde_json::from_value(probe).map_err(|e| format!("Invalid remote server manifest: {e}"))?;
	validate_version(&parsed.version)?;
	validate_sha256(&parsed.sha256)?;
	validate_version(&parsed.node_runtime.version)?;
	if parsed.archive.contains('/') || !parsed.archive.ends_with(".tgz") {
		return Err("Remote server manifest archive name is invalid".to_string());
	}
	for sha in parsed.node_runtime.sha256.values() {
		validate_sha256(sha)?;
	}
	Ok(RemoteServerManifest {
		version: parsed.version,
		archive: parsed.archive,
		sha256: parsed.sha256,
		node_version: parsed.node_runtime.version,
		node_sha256: parsed.node_runtime.sha256,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn manifest_json(schema: u64, sha: &str) -> String {
		serde_json::json!({
			"schemaVersion": schema,
			"version": "0.4.4",
			"archive": "pizza-server-0.4.4.tgz",
			"sha256": sha,
			"nodeRuntime": {
				"version": "22.23.1",
				"sha256": { "linux-x64": "b".repeat(64) }
			}
		})
		.to_string()
	}

	fn assert_valid_sh(script: &str) {
		let output = std::process::Command::new("sh")
			.arg("-n")
			.arg("-c")
			.arg(script)
			.output()
			.unwrap();
		assert!(
			output.status.success(),
			"invalid shell: {}",
			String::from_utf8_lossy(&output.stderr)
		);
	}

	#[test]
	fn service_script_keeps_user_service_alive_after_logout() {
		let script = service_setup_script("/root/.pizza/bin/pizza", false);
		assert!(script.contains("loginctl enable-linger"));
		assert!(script.contains("pizza-remote.service"));
		assert!(script.contains("RESTART='0'"));
		assert_valid_sh(&script);
	}

	#[test]
	fn service_script_checks_liveness_not_socket_file() {
		let script = service_setup_script("/home/a b/.pizza/bin/pizza", true);
		assert!(script.contains("PIZZA='/home/a b/.pizza/bin/pizza'"));
		assert!(script.contains("gateway stop --drain"));
		assert!(!script.contains("[ -S \"$SOCKET\" ]"));
		assert_valid_sh(&script);
	}

	#[test]
	fn install_script_is_valid_shell_and_quotes_values() {
		let script = install_script(&InstallParams {
			home: "/home/o'neil",
			version: "0.4.4",
			expected_sha256: &"a".repeat(64),
			archive: "/home/o'neil/.pizza/bootstrap/pizza-server-0.4.4.tgz",
			node_version: "22.23.1",
			node_arch: "linux-x64",
			node_sha256: &"b".repeat(64),
			node_mirror: DEFAULT_NODE_MIRROR,
		});
		assert!(script.contains("HOME='/home/o'\"'\"'neil'"));
		assert!(!script.contains("npm install"));
		assert!(script.contains(NODE_DOWNLOAD_FAILED_MARKER));
		assert_valid_sh(&script);
	}

	#[test]
	fn managed_gateway_socket_uses_remote_home_without_double_slash() {
		assert_eq!(managed_gateway_socket("/root/"), "/root/.pizza/gateway.sock");
		assert_eq!(managed_gateway_socket("/home/dev"), "/home/dev/.pizza/gateway.sock");
	}

	#[test]
	fn version_ordering() {
		assert!(version_is_newer("0.4.5", "0.4.4"));
		assert!(version_is_newer("0.10.0", "0.9.9"));
		assert!(version_is_newer("1.0.0", "1.0.0-beta.1"));
		assert!(!version_is_newer("0.4.4", "0.4.4"));
		assert!(!version_is_newer("0.4.3", "0.4.4"));
		assert!(!version_is_newer("garbage", "0.4.4"));
		assert!(!version_is_newer("0.4.5", "garbage"));
	}

	#[test]
	fn install_decision_never_downgrades() {
		assert_eq!(install_decision("0.4.4", true, "0.4.4"), InstallDecision::Reuse);
		assert_eq!(install_decision("0.4.5", true, "0.4.4"), InstallDecision::KeepNewer);
		assert_eq!(install_decision("0.4.3", true, "0.4.4"), InstallDecision::Install);
		assert_eq!(install_decision("", true, "0.4.4"), InstallDecision::Install);
		assert_eq!(install_decision("0.4.5", false, "0.4.4"), InstallDecision::Install);
	}

	#[test]
	fn manifest_parser_requires_supported_schema_and_sha256() {
		let parsed = parse_remote_server_manifest(&manifest_json(2, &"a".repeat(64))).unwrap();
		assert_eq!(parsed.version, "0.4.4");
		assert_eq!(parsed.node_version, "22.23.1");
		assert_eq!(parsed.node_sha256("linux-x64").unwrap(), "b".repeat(64));
		assert!(parsed.node_sha256("linux-arm64").is_err());

		assert!(parse_remote_server_manifest(&manifest_json(1, &"a".repeat(64))).is_err());
		assert!(parse_remote_server_manifest(&manifest_json(2, "not-a-sha")).is_err());
	}

	/// End-to-end install against a Linux container. Run with
	/// `PIZZA_REMOTE_E2E_CONTAINER=<name> cargo test remote_e2e -- --ignored`
	/// after `npm run build:remote-server`; the container needs no Node.
	#[cfg(unix)]
	#[test]
	#[ignore]
	fn remote_e2e_install_into_container() {
		use std::os::unix::fs::PermissionsExt;
		let container = std::env::var("PIZZA_REMOTE_E2E_CONTAINER").expect("container name");
		let root = std::env::temp_dir().join(format!("pizza-e2e-{}", uuid::Uuid::new_v4()));
		std::fs::create_dir_all(&root).unwrap();
		let fake_ssh = root.join("ssh");
		std::fs::write(
			&fake_ssh,
			format!(
				"#!/bin/sh\nfor arg in \"$@\"; do last=\"$arg\"; done\nexec docker exec -i {container} sh -c \"$last\"\n"
			),
		)
		.unwrap();
		std::fs::set_permissions(&fake_ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
		std::env::set_var("PIZZA_SSH_BIN", &fake_ssh);

		let asset_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist/remote");
		let manifest = remote_server_manifest(&asset_dir.join("manifest.json")).unwrap();
		let config = RemoteWorkspaceConfig {
			id: "e2e".to_string(),
			label: "e2e".to_string(),
			ssh_target: "e2e".to_string(),
			port: None,
			identity_file: None,
			password: None,
			password_in_keychain: false,
			remote_path: "/".to_string(),
			pizza_command: None,
			sync_credentials: false,
			created_at: 0,
			last_accessed_at: 0,
		};
		let socket = root.join("control.sock");
		let first = ensure_remote_server(&config, &socket, &asset_dir, &manifest).unwrap();
		assert_eq!(first.version, manifest.version);
		let second = ensure_remote_server(&config, &socket, &asset_dir, &manifest).unwrap();
		assert_eq!(second.version, manifest.version);
		assert!(probe_managed_gateway(&config, &socket, &manifest.version)
			.unwrap()
			.is_some());
		let _ = std::fs::remove_dir_all(root);
	}
}
