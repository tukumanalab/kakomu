mod commands;
mod cutline;
mod error;
mod export;
mod matting;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::image::import_image,
            commands::image::clear_workspace,
            matting::list_models,
            matting::remove_background,
            export::export_pdf,
            export::write_text_file,
            export::ensure_directory,
            cutline::generate_cutline,
        ])
        .run(tauri::generate_context!())
        .expect("kakomu の起動に失敗しました");
}
