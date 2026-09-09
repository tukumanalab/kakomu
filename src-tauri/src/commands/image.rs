//! 画像の取り込み。
//!
//! 実寸で扱うツールなので、取り込み時に「この画像は何ミリなのか」を決める必要がある。
//! 画像に解像度が書かれていればそれを使い、無ければ 350dpi と仮定する（SPEC 7.1）。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// これを超える画像は、そのままでは扱えないので断る（SPEC 11.3）
const MAX_SIDE_PX: u32 = 16_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    pub asset_id: String,
    /// アプリのキャッシュに複製した先。フロントは convertFileSrc でこれを表示する
    pub path: String,
    pub width_px: u32,
    pub height_px: u32,
    /// 画像に書かれていた解像度。読めなければ null
    pub dpi: Option<f64>,
    pub original_name: String,
}

#[tauri::command]
pub async fn import_image(app: AppHandle, path: String) -> Result<ImportedImage> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(Error::NotFound(path));
    }

    let (width_px, height_px) = image::image_dimensions(&src)?;
    if width_px > MAX_SIDE_PX || height_px > MAX_SIDE_PX {
        return Err(Error::TooLarge {
            width: width_px,
            height: height_px,
            max: MAX_SIDE_PX,
        });
    }

    let bytes = fs::read(&src)?;
    let dpi = read_dpi(&bytes);

    // 元画像は無改変で複製する。非破壊編集を保証するため（SPEC 6.2）
    let asset_id = new_id();
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase();
    let dir = assets_dir(&app)?;
    let dest = dir.join(format!("{asset_id}.{ext}"));
    fs::write(&dest, &bytes)?;

    Ok(ImportedImage {
        asset_id,
        path: dest.to_string_lossy().into_owned(),
        width_px,
        height_px,
        dpi,
        original_name: src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    })
}

fn assets_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_cache_dir()?.join("assets");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("as_{nanos:x}")
}

/// PNG の pHYs と JPEG の JFIF から解像度を読む。
/// どちらも読めなければ None を返し、呼び出し側が既定値を使う。
fn read_dpi(bytes: &[u8]) -> Option<f64> {
    read_png_dpi(bytes).or_else(|| read_jpeg_dpi(bytes))
}

/// PNG の pHYs チャンク。単位が「メートル」のときだけ意味を持つ
fn read_png_dpi(bytes: &[u8]) -> Option<f64> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 8 || bytes[..8] != SIGNATURE {
        return None;
    }
    let mut i = 8usize;
    while i + 8 <= bytes.len() {
        let len = u32::from_be_bytes(bytes.get(i..i + 4)?.try_into().ok()?) as usize;
        let kind = bytes.get(i + 4..i + 8)?;
        if kind == b"pHYs" {
            let data = bytes.get(i + 8..i + 8 + len)?;
            if data.len() < 9 {
                return None;
            }
            let ppu_x = u32::from_be_bytes(data[0..4].try_into().ok()?);
            let unit = data[8];
            // unit == 1 は「ピクセル毎メートル」
            if unit == 1 && ppu_x > 0 {
                return Some(f64::from(ppu_x) * 0.0254);
            }
            return None;
        }
        if kind == b"IDAT" || kind == b"IEND" {
            return None;
        }
        // 長さ(4) + 種別(4) + データ + CRC(4)
        i = i.checked_add(12)?.checked_add(len)?;
    }
    None
}

/// JPEG の APP0 (JFIF) セグメントの density
fn read_jpeg_dpi(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        let marker = bytes[i + 1];
        // スキャン開始以降にメタデータは無い
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let len = u16::from_be_bytes(bytes.get(i + 2..i + 4)?.try_into().ok()?) as usize;
        if marker == 0xE0 {
            let seg = bytes.get(i + 4..i + 2 + len)?;
            if seg.len() >= 12 && &seg[0..5] == b"JFIF\0" {
                let units = seg[7];
                let x_density = u16::from_be_bytes(seg[8..10].try_into().ok()?);
                if x_density == 0 {
                    return None;
                }
                return match units {
                    1 => Some(f64::from(x_density)),        // 1 インチあたり
                    2 => Some(f64::from(x_density) * 2.54), // 1 センチあたり
                    _ => None,                              // 比率のみ。実寸は不明
                };
            }
        }
        i = i.checked_add(2)?.checked_add(len)?;
    }
    None
}

/// 取り込んだ画像の一時ファイルをまとめて消す（共用 PC モードの「おわる」）
#[tauri::command]
pub fn clear_workspace(app: AppHandle) -> Result<()> {
    let dir = assets_dir(&app)?;
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

#[allow(dead_code)]
pub fn is_supported(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "tif" | "tiff")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_without_phys_has_no_dpi() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        // IHDR チャンク（中身は読まないので長さと種別だけ整合していればよい）
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0u8; 13]);
        png.extend_from_slice(&[0u8; 4]);
        // IDAT に到達したら打ち切る
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IDAT");
        png.extend_from_slice(&[0u8; 4]);
        assert_eq!(read_png_dpi(&png), None);
    }

    #[test]
    fn png_phys_is_converted_to_dpi() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&9u32.to_be_bytes());
        png.extend_from_slice(b"pHYs");
        // 11811 px/m ≒ 300dpi
        png.extend_from_slice(&11811u32.to_be_bytes());
        png.extend_from_slice(&11811u32.to_be_bytes());
        png.push(1);
        png.extend_from_slice(&[0u8; 4]);
        let dpi = read_png_dpi(&png).expect("pHYs を読めること");
        assert!((dpi - 300.0).abs() < 1.0, "300dpi 付近のはず: {dpi}");
    }

    #[test]
    fn jpeg_jfif_inch_density() {
        let mut jpg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        let seg: Vec<u8> = {
            let mut s = Vec::new();
            s.extend_from_slice(b"JFIF\0");
            s.extend_from_slice(&[1, 2]); // version
            s.push(1); // units = インチ
            s.extend_from_slice(&72u16.to_be_bytes());
            s.extend_from_slice(&72u16.to_be_bytes());
            s.extend_from_slice(&[0, 0]); // thumbnail
            s
        };
        jpg.extend_from_slice(&((seg.len() + 2) as u16).to_be_bytes());
        jpg.extend_from_slice(&seg);
        assert_eq!(read_jpeg_dpi(&jpg), Some(72.0));
    }
}
