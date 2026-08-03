mod git;
mod provider;
mod terminal;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(workspace::WorkspaceState::default())
        .manage(terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            workspace::choose_workspace,
            workspace::restore_workspace,
            workspace::set_workspace,
            workspace::list_tree,
            workspace::read_file,
            workspace::write_file,
            workspace::search_workspace,
            workspace::stat_path,
            workspace::agent_write_file,
            provider::provider_stream,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            git::git_changes,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_revert,
            git::git_checkpoint,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
