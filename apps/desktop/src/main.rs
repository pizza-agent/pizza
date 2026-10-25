// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod browser_view;
mod gateway_channel;
mod remote;
mod remote_deploy;
mod updater;

use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};

fn main() {
	env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
	tauri::Builder::default()
		.plugin(tauri_plugin_shell::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_updater::Builder::new().build())
		.manage(bridge::BridgeState::default())
		.manage(browser_view::BrowserViewState::default())
		.invoke_handler(tauri::generate_handler![
			bridge::init_sidecar,
			bridge::main_agent_status,
			bridge::stop_main_agent,
			bridge::stop_sidecar,
			bridge::rpc_command,
			bridge::channel_op,
			bridge::new_workspace,
			bridge::toggle_pet_window,
			bridge::close_pet_window,
			bridge::open_pet_settings,
			bridge::get_pet_state,
			bridge::list_workspaces,
			bridge::add_remote_workspace,
			bridge::browse_remote_directories,
			bridge::delete_workspace,
			bridge::reveal_workspace,
			bridge::reveal_file,
			bridge::describe_dropped_files,
			bridge::save_upload,
			bridge::list_providers,
			bridge::set_provider_api_key,
			bridge::remove_provider_api_key,
			bridge::save_custom_provider,
			bridge::test_custom_provider,
			bridge::remove_custom_provider,
			bridge::restart_sidecar,
			bridge::set_window_background,
			bridge::transcribe_audio,
			bridge::list_dir,
			bridge::read_file,
			bridge::read_voice_clip,
			bridge::search_files,
			bridge::open_in_editor,
			bridge::reveal_path,
			bridge::git_status,
			bridge::git_diff,
			bridge::git_branches,
			bridge::git_log,
			bridge::git_show,
			bridge::fetch_skills_sh,
			bridge::fetch_pi_packages,
			bridge::oauth_login,
			bridge::oauth_login_answer,
			bridge::oauth_login_cancel,
			bridge::list_auth_options,
			bridge::check_app_update,
			browser_view::browser_view_open_tab,
			browser_view::browser_view_navigate,
			browser_view::browser_view_activate_tab,
			browser_view::browser_view_close_tab,
			browser_view::browser_view_set_rect,
			browser_view::browser_view_set_visible,
			browser_view::browser_view_focus,
			browser_view::browser_view_exec,
			browser_view::browser_view_open_devtools,
			browser_view::browser_view_refresh,
			browser_view::browser_view_go_back,
			browser_view::browser_view_go_forward,
			browser_view::browser_view_reload,
			browser_view::browser_view_allow_permission,
			browser_view::browser_view_list_permissions,
			browser_view::browser_view_focus_main,
			updater::install_app_update,
		])
		.setup(|app| {
			bridge::start_scheduler_sidecar_guard(app.handle().clone());
			bridge::warm_remote_transports(app.handle().clone());
			// Pre-fetch `pizza auth list --json` so Settings doesn't wait ~1s
			// for a CLI spawn on first open.
			let warmup_app = app.handle().clone();
			std::thread::spawn(move || bridge::warm_auth_options(&warmup_app));
			#[cfg(debug_assertions)]
			{
				if let Some(window) = app.get_webview_window("main") {
					window.open_devtools();
				}
			}
			// Restore the floating pet window if a pet exists from a previous run.
			bridge::maybe_reopen_pet_window(&app.handle());
			Ok(())
		})
		.on_window_event(|window, event| match event {
			WindowEvent::Destroyed => {
				if window.label() == bridge::PET_WINDOW_LABEL {
					bridge::log_file("pet window destroyed");
				}
			}
			WindowEvent::CloseRequested { .. } => {
				let label = window.label().to_string();
				// The floating pet window owns no sidecar — just tell the other
				// windows it closed so the in-app widget can reappear.
				if label == bridge::PET_WINDOW_LABEL {
					for l in window.app_handle().webview_windows().keys() {
						if let Some(w) = window.app_handle().get_webview_window(l) {
							let _ =
								w.emit("pet_window_state", serde_json::json!({ "open": false }));
						}
					}
					return;
				}
				log::info!("window {} closed, stopping its sidecar", label);
				let state = window.app_handle().state::<bridge::BridgeState>();
				bridge::kill_sidecar_for_window(state.inner(), &label);
			}
			WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
				let paths: Vec<String> = paths
					.iter()
					.map(|path| path.to_string_lossy().to_string())
					.collect();
				bridge::log_file(&format!("native_file_drop: {:?}", paths));
				let _ = window.emit("native_file_drop", serde_json::json!({ "paths": paths }));
			}
			_ => {}
		})
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
