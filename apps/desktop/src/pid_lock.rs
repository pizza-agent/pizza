//! Reader for the pid lockfiles written by `acquirePidLock`
//! (src/core/agent/main-agent.ts): JSON `{ pid, startedAt, ...meta }`.
//! Used for the main agent lock
//! (`~/.pizza/main/.lock`) and the gateway ownership lock
//! (`<agentDir>/gateway.lock`).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub struct LockInfo {
	pub pid: u32,
	/// Epoch ms when the owner started — distinguishes it from a reused pid.
	pub started_at: u64,
	meta: Value,
}

impl LockInfo {
	pub fn str_field(&self, key: &str) -> Option<String> {
		self.meta.get(key).and_then(Value::as_str).map(str::to_string)
	}
}

pub fn read_lock(path: &Path) -> Option<LockInfo> {
	let meta: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
	let pid = meta
		.get("pid")
		.and_then(Value::as_u64)
		.and_then(|p| u32::try_from(p).ok())?;
	let started_at = meta.get("startedAt").and_then(Value::as_f64)? as u64;
	Some(LockInfo {
		pid,
		started_at,
		meta,
	})
}

/// Mirrors START_TIME_TOLERANCE_MS in main-agent.ts.
const START_TIME_TOLERANCE_MS: u64 = 15_000;

/// True if the lock's owner is still the process that wrote it: alive, and
/// started at the recorded time (not a reused pid).
pub fn owner_alive(info: &LockInfo) -> bool {
	is_process_alive(info.pid)
		&& process_started_at(info.pid)
			.is_none_or(|actual| info.started_at.abs_diff(actual) <= START_TIME_TOLERANCE_MS)
}

/// `<agentDir>` as resolved by `getAgentDir()` in src/config.ts.
pub fn agent_dir() -> Option<PathBuf> {
	let home = std::env::var("HOME")
		.or_else(|_| std::env::var("USERPROFILE"))
		.ok()
		.filter(|h| !h.is_empty())
		.map(PathBuf::from);
	match std::env::var("PIZZA_AGENT_DIR").ok().filter(|d| !d.is_empty()) {
		Some(dir) if dir == "~" => home,
		Some(dir) if dir.starts_with("~/") => home.map(|h| h.join(&dir[2..])),
		Some(dir) => Some(PathBuf::from(dir)),
		None => home.map(|h| h.join(".pizza").join("agent")),
	}
}

#[cfg(unix)]
pub fn is_process_alive(pid: u32) -> bool {
	Command::new("kill")
		.args(["-0", &pid.to_string()])
		.status()
		.map(|status| status.success())
		.unwrap_or(false)
}

#[cfg(windows)]
pub fn is_process_alive(pid: u32) -> bool {
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
pub fn is_process_alive(_pid: u32) -> bool {
	false
}

#[cfg(unix)]
fn ps_field(pid: u32, field: &str) -> Option<String> {
	let output = Command::new("ps")
		.args(["-p", &pid.to_string(), "-o", &format!("{field}=")])
		.output()
		.ok()?;
	if !output.status.success() {
		return None;
	}
	let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
	(!value.is_empty()).then_some(value)
}

#[cfg(unix)]
pub fn process_command(pid: u32) -> Option<String> {
	ps_field(pid, "command")
}

#[cfg(windows)]
pub fn process_command(pid: u32) -> Option<String> {
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
	(!command.is_empty()).then_some(command)
}

#[cfg(not(any(unix, windows)))]
pub fn process_command(_pid: u32) -> Option<String> {
	None
}

#[cfg(unix)]
fn process_started_at(pid: u32) -> Option<u64> {
	let elapsed = parse_etime(&ps_field(pid, "etime")?)?;
	let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
	Some(now.saturating_sub(elapsed * 1000))
}

#[cfg(not(unix))]
fn process_started_at(_pid: u32) -> Option<u64> {
	None
}

/// Parse `ps -o etime` (`[[dd-]hh:]mm:ss`) into seconds.
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_etime(etime: &str) -> Option<u64> {
	let (days, rest) = match etime.split_once('-') {
		Some((d, r)) => (d.parse::<u64>().ok()?, r),
		None => (0, etime),
	};
	let parts: Vec<u64> = rest
		.split(':')
		.map(|p| p.parse().ok())
		.collect::<Option<_>>()?;
	let (h, m, s) = match parts.as_slice() {
		[m, s] => (0, *m, *s),
		[h, m, s] => (*h, *m, *s),
		_ => return None,
	};
	Some(((days * 24 + h) * 60 + m) * 60 + s)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_etime_formats() {
		assert_eq!(parse_etime("00:05"), Some(5));
		assert_eq!(parse_etime("01:02:03"), Some(3723));
		assert_eq!(parse_etime("2-01:02:03"), Some(2 * 86_400 + 3723));
		assert_eq!(parse_etime("junk"), None);
	}

	#[test]
	fn reads_json_locks() {
		let dir = std::env::temp_dir().join(format!("pizza-pidlock-{}", uuid::Uuid::new_v4()));
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join(".lock");

		std::fs::write(&path, "1234\n").unwrap();
		assert!(read_lock(&path).is_none());
		std::fs::write(&path, r#"{"pid":1234}"#).unwrap();
		assert!(read_lock(&path).is_none());

		std::fs::write(
			&path,
			r#"{"gatewaySocket":"/tmp/gw.sock","pid":42,"startedAt":1700000000000}"#,
		)
		.unwrap();
		let info = read_lock(&path).unwrap();
		assert_eq!(info.pid, 42);
		assert_eq!(info.started_at, 1_700_000_000_000);
		assert_eq!(info.str_field("gatewaySocket").as_deref(), Some("/tmp/gw.sock"));

		std::fs::write(&path, "{broken").unwrap();
		assert!(read_lock(&path).is_none());
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[cfg(unix)]
	#[test]
	fn detects_reused_pid_by_start_time() {
		let me = std::process::id();
		let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
		let fresh = |started_at: u64| LockInfo {
			pid: me,
			started_at,
			meta: Value::Null,
		};
		let actual = process_started_at(me).unwrap();
		assert!(owner_alive(&fresh(actual)));
		assert!(!owner_alive(&fresh(now + 86_400_000)));
	}
}
