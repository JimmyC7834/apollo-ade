mod browser;
mod exec;
mod git;
mod lsp;
mod profiles;
mod provider;
mod reaper;
mod spawn;
mod rtk;
mod terminal;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(workspace::WorkspaceState::default())
        .manage(workspace::SessionRoots::default())
        .manage(workspace::Writers::default())
        .manage(terminal::TerminalState::default())
        .manage(exec::ExecState::default())
        .manage(lsp::LspState::default())
        .invoke_handler(tauri::generate_handler![
            workspace::choose_workspace,
            workspace::restore_workspace,
            workspace::set_workspace,
            workspace::recent_workspaces,
            workspace::create_agent_session,
            workspace::close_agent_session,
            workspace::focus_agent_session,
            workspace::label_agent_session,
            workspace::checkpoint_contention,
            workspace::list_tree,
            workspace::read_file,
            workspace::write_file,
            workspace::search_workspace,
            workspace::stat_path,
            workspace::agent_write_file,
            workspace::agent_append_file,
            workspace::agent_create_dir,
            workspace::agent_list_dir,
            workspace::create_file,
            workspace::create_folder,
            workspace::rename_entry,
            workspace::delete_plan,
            workspace::delete_entry,
            workspace::read_text_lines,
            workspace::global_skills_path,
            profiles::read_global_profiles,
            profiles::global_profiles_path,
            provider::provider_stream,
            exec::agent_exec,
            exec::agent_exec_cancel,
            exec::agent_shell,
            rtk::rtk_resolve,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            browser::browser_open,
            browser::browser_place,
            browser::browser_navigate,
            browser::browser_close,
            browser::browser_eval,
            browser::browser_return_focus,
            browser::browser_open_external,
            git::git_branch,
            git::git_changes,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_revert,
            git::git_checkpoint,
            git::git_restore_checkpoint,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // `build` + `run` rather than `Builder::run`, for one reason: a language
        // server has to be killed when the app goes, and this callback is the
        // only place that is guaranteed to happen. A leaked `rust-analyzer` is
        // a gigabyte of resident memory with nothing left to talk to.
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                lsp::shutdown_all(app);
            }
        });
}
