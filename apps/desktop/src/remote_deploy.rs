/**
 * Versioned remote Pizza server installation and daemon lifecycle.
 *
 * This follows the same lifecycle as the remote clients: probe first, install
 * into an immutable version directory, verify the executable, switch the
 * launcher atomically, then start or reuse a per-user daemon.
 */
use crate::remote::{
	self, quote_posix_shell_arg, run_remote_shell, upload_file, RemoteWorkspaceConfig,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Child;

const REMOTE_NODE_VERSION: &str = "22.23.1";

#[derive(Clone, Debug)]
pub struct RemoteServerInstall {
	pub version: String,
	pub pizza_command: String,
	pub gateway_socket: String,
	pub service_mode: String,
}

#[derive(Debug)]
struct RemoteRuntimeProbe {
	home: String,
	platform: String,
	arch: String,
	managed_version: String,
	managed_command_ok: bool,
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
	if sha256.len() != 64
		|| !sha256
			.chars()
			.all(|character| character.is_ascii_hexdigit())
	{
		return Err("Remote server archive SHA-256 is invalid".to_string());
	}
	Ok(())
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

fn service_setup_script(pizza_command: &str, restart: bool) -> String {
	let pizza = quote_posix_shell_arg(pizza_command);
	format!(
		r#"
set -eu
PIZZA={pizza}
SOCKET="$HOME/.pizza/gateway.sock"
RESTART={restart}
SERVICE_MODE=detached
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  # User services are removed when the last login session ends unless
  # lingering is enabled. Keep the remote gateway alive after SSH disconnects.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  fi
  SERVICE_DIR="$HOME/.config/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/pizza-remote.service"
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_FILE" <<'PIZZA_SERVICE'
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
  systemctl --user daemon-reload
  systemctl --user enable pizza-remote.service >/dev/null 2>&1 || true
  if [ "$RESTART" = "1" ]; then
    systemctl --user restart pizza-remote.service
  else
    systemctl --user start pizza-remote.service
  fi
  SERVICE_MODE=systemd
else
  if [ "$RESTART" = "1" ]; then
    "$PIZZA" gateway restart >/dev/null
  else
    "$PIZZA" gateway start >/dev/null
  fi
fi
i=0
while [ "$i" -lt 100 ]; do
  if [ -S "$SOCKET" ]; then
    printf 'SERVICE_MODE=%s\n' "$SERVICE_MODE"
    printf 'GATEWAY_SOCKET=%s\n' "$SOCKET"
    exit 0
  fi
  i=$((i + 1))
  sleep 0.2
done
echo "Pizza gateway socket did not become ready" >&2
exit 1
"#
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
	let expected = quote_posix_shell_arg(expected_version);
	let command = format!(
		r#"
version="$(cat "$HOME/.pizza/server/current-version" 2>/dev/null || true)"
printf 'HOME=%s\n' "$HOME"
printf 'VERSION=%s\n' "$version"
if [ "$version" = {expected} ] && [ -x "$HOME/.pizza/bin/pizza" ] && [ -S "$HOME/.pizza/gateway.sock" ]; then
  printf 'READY=1\n'
else
  printf 'READY=0\n'
fi
"#
	);
	let output = run_remote_shell(config, control_socket, &command)?;
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
	if values.get("READY").map(String::as_str) != Some("1") {
		return Ok(None);
	}
	Ok(Some(managed_gateway_socket(home)))
}

pub fn ensure_remote_server(
	config: &RemoteWorkspaceConfig,
	control_socket: &Path,
	archive_path: &Path,
	version: &str,
	expected_sha256: &str,
) -> Result<RemoteServerInstall, String> {
	validate_version(version)?;
	validate_sha256(expected_sha256)?;
	let probe = probe_remote_runtime(config, control_socket)?;
	let node_arch = node_archive_arch(&probe)?;
	let pizza_command = format!("{}/.pizza/bin/pizza", probe.home.trim_end_matches('/'));
	let gateway_socket = format!("{}/.pizza/gateway.sock", probe.home.trim_end_matches('/'));

	let installed_now = probe.managed_version != version || !probe.managed_command_ok;
	if installed_now {
		if !archive_path.exists() {
			return Err(format!(
				"Pizza remote server archive is missing: {}",
				archive_path.display()
			));
		}
		let remote_archive = format!(
			"{}/.pizza/bootstrap/pizza-server-{version}.tgz",
			probe.home.trim_end_matches('/')
		);
		upload_file(config, control_socket, &remote_archive, archive_path)?;
		let install_script = format!(
			r#"
set -eu
umask 077
HOME={home}
VERSION={version}
NODE_VERSION={node_version}
NODE_ARCH={node_arch}
ARCHIVE={archive}
EXPECTED_SHA256={expected_sha}
SERVER_ROOT="$HOME/.pizza/server"
RUNTIME_ROOT="$HOME/.pizza/runtime"
NODE_ROOT="$RUNTIME_ROOT/node-v${{NODE_VERSION}}-${{NODE_ARCH}}"
STAGING="$SERVER_ROOT/.staging-$VERSION-$$"
INSTALL_ROOT="$SERVER_ROOT/versions/$VERSION"

cd "$HOME/.pizza/bootstrap"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$EXPECTED_SHA256" "$(basename "$ARCHIVE")" | sha256sum -c -
else
  actual="$(shasum -a 256 "$ARCHIVE" | awk '{{print $1}}')"
  [ "$actual" = "$EXPECTED_SHA256" ] || {{ echo "Pizza server archive checksum mismatch" >&2; exit 1; }}
fi

if [ ! -x "$NODE_ROOT/bin/node" ]; then
  mkdir -p "$RUNTIME_ROOT"
  download=""
  if command -v curl >/dev/null 2>&1; then
    download="curl -fsSL"
  elif command -v wget >/dev/null 2>&1; then
    download="wget -qO"
  else
    echo "curl or wget is required to install the remote Node runtime" >&2
    exit 1
  fi
  node_name="node-v${{NODE_VERSION}}-${{NODE_ARCH}}"
  node_archive="$HOME/.pizza/bootstrap/${{node_name}}.tar.gz"
  shasums="$HOME/.pizza/bootstrap/SHASUMS256-$NODE_VERSION.txt"
  if [ "$download" = "curl -fsSL" ]; then
    curl -fsSL "https://nodejs.org/dist/v${{NODE_VERSION}}/${{node_name}}.tar.gz" -o "$node_archive"
    curl -fsSL "https://nodejs.org/dist/v${{NODE_VERSION}}/SHASUMS256.txt" -o "$shasums"
  else
    wget -qO "$node_archive" "https://nodejs.org/dist/v${{NODE_VERSION}}/${{node_name}}.tar.gz"
    wget -qO "$shasums" "https://nodejs.org/dist/v${{NODE_VERSION}}/SHASUMS256.txt"
  fi
  expected_node_sha="$(awk -v name="${{node_name}}.tar.gz" '$2 == name {{print $1}}' "$shasums")"
  [ -n "$expected_node_sha" ] || {{ echo "Remote Node runtime checksum is unavailable" >&2; exit 1; }}
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$expected_node_sha" "$(basename "$node_archive")" | (cd "$(dirname "$node_archive")" && sha256sum -c -)
  else
    actual="$(shasum -a 256 "$node_archive" | awk '{{print $1}}')"
    [ "$actual" = "$expected_node_sha" ] || {{ echo "Remote Node runtime checksum mismatch" >&2; exit 1; }}
  fi
  extract="$RUNTIME_ROOT/.extract-$NODE_VERSION-$$"
  rm -rf "$extract"
  mkdir -p "$extract"
  tar -xzf "$node_archive" -C "$extract"
  if [ -e "$NODE_ROOT" ]; then
    mv "$NODE_ROOT" "$NODE_ROOT.incomplete-$(date +%s)"
  fi
  mv "$extract/$node_name" "$NODE_ROOT"
fi
export PATH="$NODE_ROOT/bin:$PATH"

mkdir -p "$SERVER_ROOT/versions"
rm -rf "$STAGING"
mkdir -p "$STAGING"
"$NODE_ROOT/bin/npm" install --global --prefix "$STAGING" "$ARCHIVE" \
  --fund=false --audit=false --allow-scripts=node-pty,@google/genai,protobufjs
version_output="$("$STAGING/bin/pizza" --version 2>&1 | head -n 1)"
[ "$version_output" = "$VERSION" ] || {{ echo "Installed Pizza version mismatch: $version_output" >&2; exit 1; }}

if [ -e "$INSTALL_ROOT" ]; then
  mv "$INSTALL_ROOT" "$INSTALL_ROOT.backup-$(date +%s)"
fi
mv "$STAGING" "$INSTALL_ROOT"
mkdir -p "$HOME/.pizza/bin"
wrapper="$HOME/.pizza/bin/pizza"
if [ -f "$wrapper" ]; then
  cp "$wrapper" "$wrapper.backup-$(date +%s)"
fi
wrapper_tmp="$wrapper.tmp-$$"
cat > "$wrapper_tmp" <<PIZZA_WRAPPER
#!/bin/sh
export PATH="$NODE_ROOT/bin:\$PATH"
exec "$INSTALL_ROOT/bin/pizza" "\$@"
PIZZA_WRAPPER
chmod 700 "$wrapper_tmp"
mv "$wrapper_tmp" "$wrapper"
printf '%s\n' "$VERSION" > "$SERVER_ROOT/current-version"
cat > "$SERVER_ROOT/install.json" <<PIZZA_INSTALL
{{"schemaVersion":1,"version":"$VERSION","nodeVersion":"$NODE_VERSION","nodeArch":"$NODE_ARCH","installRoot":"$INSTALL_ROOT","updatedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}}
PIZZA_INSTALL
printf 'INSTALL_ROOT=%s\n' "$INSTALL_ROOT"
printf 'PIZZA_COMMAND=%s\n' "$wrapper"
"#,
			home = quote_posix_shell_arg(&probe.home),
			version = quote_posix_shell_arg(version),
			node_version = quote_posix_shell_arg(REMOTE_NODE_VERSION),
			node_arch = quote_posix_shell_arg(node_arch),
			archive = quote_posix_shell_arg(&remote_archive),
			expected_sha = quote_posix_shell_arg(expected_sha256),
		);
		let output = run_remote_shell(config, control_socket, &install_script)?;
		if !output.success {
			let detail = output.stderr.trim();
			return Err(if detail.is_empty() {
				"Remote Pizza server installation failed".to_string()
			} else {
				format!("Remote Pizza server installation failed: {detail}")
			});
		}
	}

	let service_mode = ensure_service(config, control_socket, &pizza_command, installed_now)?;
	Ok(RemoteServerInstall {
		version: version.to_string(),
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

pub fn remote_server_manifest(manifest_path: &Path) -> Result<(String, String), String> {
	let raw = std::fs::read_to_string(manifest_path)
		.map_err(|e| format!("Failed to read remote server manifest: {e}"))?;
	parse_remote_server_manifest(&raw)
}

fn parse_remote_server_manifest(raw: &str) -> Result<(String, String), String> {
	let parsed: Value =
		serde_json::from_str(raw).map_err(|e| format!("Invalid remote server manifest: {e}"))?;
	if parsed.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
		return Err("Unsupported remote server manifest schema".to_string());
	}
	let version = parsed
		.get("version")
		.and_then(Value::as_str)
		.ok_or_else(|| "Remote server manifest has no version".to_string())?
		.to_string();
	let sha256 = parsed
		.get("sha256")
		.and_then(Value::as_str)
		.ok_or_else(|| "Remote server manifest has no SHA-256".to_string())?
		.to_string();
	validate_version(&version)?;
	validate_sha256(&sha256)?;
	Ok((version, sha256))
}

pub fn remote_install_archive(resource_dir: &Path, archive_name: &str) -> PathBuf {
	resource_dir.join(archive_name)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn service_script_keeps_user_service_alive_after_logout() {
		let script = service_setup_script("/root/.pizza/bin/pizza", false);
		assert!(script.contains("loginctl enable-linger"));
		assert!(script.contains("pizza-remote.service"));
	}

	#[test]
	fn managed_gateway_socket_uses_remote_home_without_double_slash() {
		assert_eq!(
			managed_gateway_socket("/root/"),
			"/root/.pizza/gateway.sock"
		);
		assert_eq!(
			managed_gateway_socket("/home/dev"),
			"/home/dev/.pizza/gateway.sock"
		);
	}

	#[test]
	fn manifest_parser_requires_supported_schema_and_sha256() {
		let valid = serde_json::json!({
			"schemaVersion": 1,
			"version": "0.4.2",
			"sha256": "a".repeat(64)
		});
		assert_eq!(
			parse_remote_server_manifest(&valid.to_string()).unwrap(),
			("0.4.2".to_string(), "a".repeat(64))
		);

		let unsupported = serde_json::json!({
			"schemaVersion": 2,
			"version": "0.4.2",
			"sha256": "a".repeat(64)
		});
		assert!(parse_remote_server_manifest(&unsupported.to_string()).is_err());

		let invalid_sha = serde_json::json!({
			"schemaVersion": 1,
			"version": "0.4.2",
			"sha256": "not-a-sha"
		});
		assert!(parse_remote_server_manifest(&invalid_sha.to_string()).is_err());
	}
}
