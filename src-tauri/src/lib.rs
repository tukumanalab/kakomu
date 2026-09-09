mod commands;
mod error;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::image::import_image,
            commands::image::clear_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("kakomu の起動に失敗しました");
}
