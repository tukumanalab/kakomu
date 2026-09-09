//! 加工機に渡すデータの書き出し。
//!
//! 切るデータ（SVG）は文書モデルを持つフロント側で組み立て、
//! ここでは文字列を受け取って書くだけ。
//! 印刷するデータ（PDF）は画像の実データを扱うのでこちら側で作る。

pub mod pdf;

use std::path::PathBuf;

use crate::error::{Error, Result};

#[tauri::command]
pub fn export_pdf(spec: pdf::PageSpec, path: String) -> Result<()> {
    pdf::write_pdf(&spec, &PathBuf::from(path))
}

/// SVG など、フロントで組み立てたテキストを書き出す
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<()> {
    let path = PathBuf::from(path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, contents.as_bytes())?;
    Ok(())
}

/// 書き出し先のフォルダに、同じ名前で 2 つ並べて置けるかを確かめる
#[tauri::command]
pub fn ensure_directory(path: String) -> Result<()> {
    let path = PathBuf::from(&path);
    if !path.is_dir() {
        return Err(Error::NotFound(path.to_string_lossy().into_owned()));
    }
    Ok(())
}
