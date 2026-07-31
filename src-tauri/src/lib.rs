mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(workspace::WorkspaceState::default())
        .invoke_handler(tauri::generate_handler![
            workspace::set_workspace,
            workspace::list_tree,
            workspace::read_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
