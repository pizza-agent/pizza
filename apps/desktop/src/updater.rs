//! In-app desktop updates (tauri-plugin-updater, signed `latest.json` on
//! GitHub releases).
//!
//! Flow: download + verify the signed bundle (progress streamed to the
//! frontend) → wait until no gateway agent is mid-turn → stop the gateway and
//! all sidecars → install → relaunch. The gateway runs the bundled `pizza`
//! binary and outlives the desktop, so it must be stopped before the bundle
//! is replaced (Windows can't overwrite a running exe); while an install is in
//! progress every spawn path refuses to start a new agent process.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::{bridge, gateway_channel};

const PROGRESS_EVENT: &str = "app_update_progress";
/// How often to re-check the gateway for busy agents while draining.
const DRAIN_POLL: Duration = Duration::from_secs(2);

/// Set from the moment we start stopping agents until the process exits.
static INSTALLING: AtomicBool = AtomicBool::new(false);
/// Guards against concurrent download/install runs (double clicks, two windows).
static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn is_installing() -> bool {
	INSTALLING.load(Ordering::SeqCst)
}

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
enum UpdateProgress {
	#[serde(rename_all = "camelCase")]
	Downloading {
		downloaded: u64,
		total: Option<u64>,
	},
	/// Download done; waiting for `busy` gateway agents to finish their turn.
	#[serde(rename_all = "camelCase")]
	WaitingForAgents {
		busy: usize,
	},
	Installing,
}

fn emit(app: &AppHandle, progress: UpdateProgress) {
	let _ = app.emit(PROGRESS_EVENT, progress);
}

/// Download, verify and install the latest release, then relaunch. Waits
/// (indefinitely) for running agent turns to finish before installing.
/// Only returns on failure — success ends with the app restarting.
#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<(), String> {
	if RUNNING.swap(true, Ordering::SeqCst) {
		return Err("An update is already in progress".into());
	}
	let result = download_and_install(&app).await;
	RUNNING.store(false, Ordering::SeqCst);
	INSTALLING.store(false, Ordering::SeqCst);
	if let Err(e) = &result {
		bridge::log_file(&format!("app update failed: {e}"));
	}
	result
}

async fn download_and_install(app: &AppHandle) -> Result<(), String> {
	let update = app
		.updater()
		.map_err(|e| format!("updater unavailable: {e}"))?
		.check()
		.await
		.map_err(|e| format!("update check failed: {e}"))?
		.ok_or("No update available")?;
	bridge::log_file(&format!("app update: downloading {}", update.version));

	let mut downloaded = 0u64;
	let mut total = None;
	let mut last_emit = Instant::now() - Duration::from_secs(1);
	let bytes = update
		.download(
			|chunk, content_length| {
				downloaded += chunk as u64;
				total = content_length;
				if last_emit.elapsed() >= Duration::from_millis(100) {
					last_emit = Instant::now();
					emit(app, UpdateProgress::Downloading { downloaded, total });
				}
			},
			|| {},
		)
		.await
		.map_err(|e| format!("download failed: {e}"))?;
	emit(app, UpdateProgress::Downloading { downloaded, total });

	let drain_app = app.clone();
	tauri::async_runtime::spawn_blocking(move || stop_agent_runtime(&drain_app))
		.await
		.map_err(|e| format!("blocking task failed: {e}"))??;

	emit(app, UpdateProgress::Installing);
	bridge::log_file(&format!("app update: installing {}", update.version));
	// Windows: launches the NSIS installer and exits the process here.
	update
		.install(bytes)
		.map_err(|e| format!("install failed: {e}"))?;
	app.restart();
}

/// Wait until no gateway agent is busy, then stop the gateway and every
/// desktop-owned sidecar. New spawns are blocked from here on.
fn stop_agent_runtime(app: &AppHandle) -> Result<(), String> {
	let socket = gateway_channel::gateway_socket_path();
	if let Some(socket) = &socket {
		while let Some(busy) = gateway_channel::busy_agent_count(socket).filter(|&n| n > 0) {
			emit(app, UpdateProgress::WaitingForAgents { busy });
			std::thread::sleep(DRAIN_POLL);
		}
	}
	INSTALLING.store(true, Ordering::SeqCst);
	bridge::shutdown_all_agents(app.state::<bridge::BridgeState>().inner());
	if let Some(socket) = &socket {
		if !gateway_channel::stop_gateway(socket) {
			bridge::log_file("app update: gateway did not stop within 10s");
			// Windows can't replace a bundle whose pizza.exe is still running.
			if cfg!(windows) {
				return Err("The Pizza gateway did not stop; please quit it and retry".into());
			}
		}
	}
	Ok(())
}
