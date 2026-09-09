//! フロントに返すエラー。
//! panic でプロセスを落とさず、UI にダイアログとして出せる形にする（SPEC 11.3）。

use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ファイルが見つかりません: {0}")]
    NotFound(String),

    #[error("画像が大きすぎます（{width}×{height}px、上限は {max}px）")]
    TooLarge { width: u32, height: u32, max: u32 },

    #[error("画像を読めませんでした: {0}")]
    Image(#[from] image::ImageError),

    #[error("ファイルの読み書きに失敗しました: {0}")]
    Io(#[from] std::io::Error),

    #[error("保存先を決められませんでした: {0}")]
    Path(#[from] tauri::Error),

    #[error("モデルをダウンロードできませんでした: {0}")]
    Download(String),

    #[error("背景を消せませんでした: {0}")]
    Inference(String),

    #[error("知らないモデルです: {0}")]
    UnknownModel(String),

    #[error("書き出せませんでした: {0}")]
    Export(String),
}

/// フロント側では文字列として受け取る
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
