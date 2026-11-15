//! Hide console windows for child processes on Windows.
//!
//! The desktop app is built with `windows_subsystem = "windows"`, but child
//! processes (the Pizza sidecar, git, ssh, auth login) default to
//! console-subsystem executables. Without `CREATE_NO_WINDOW` Windows gives each
//! one a fresh console window, which is the "mystery terminal" users see after
//! launch. The flag is harmless for GUI processes and is a no-op off Windows.

use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// `CREATE_NO_WINDOW` from the Windows process creation flags.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the console window a child process would otherwise allocate.
///
/// Call this immediately before `spawn()` / `status()` on a `Command` that has
/// not already set its own creation flags. Do not combine it with
/// `DETACHED_PROCESS` in a later `creation_flags()` call: that call replaces
/// flags rather than adding to them.
pub fn hide_console(_command: &mut Command) {
	#[cfg(windows)]
	_command.creation_flags(CREATE_NO_WINDOW);
}
