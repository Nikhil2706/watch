mod offline;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // The storage half of src/lib/offline. The web UI is identical to the
        // Android app's; only these five functions differ per platform.
        .invoke_handler(tauri::generate_handler![
            offline::offline_start,
            offline::offline_list,
            offline::offline_remove,
            offline::offline_local_url,
            offline::offline_read_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
