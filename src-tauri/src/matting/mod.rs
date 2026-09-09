//! 背景除去。
//!
//! 推論はすべて手元で動かす。画像を外に送らない（SPEC 11.4）。
//! 未成年が使うため、ここは通常より厳しくしている。
//!
//! ネットワークを使うのはモデルの初回ダウンロードだけ。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma, Rgba};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

// ---------------------------------------------------------------- モデル

#[derive(Debug, Clone, Copy)]
pub struct Model {
    pub id: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    /// モデルが受け取る正方形の一辺
    pub input: u32,
    /// 前処理の正規化
    pub mean: [f32; 3],
    pub std: [f32; 3],
    /// UI の選択肢に出すか。false のものはテストからだけ使う
    pub selectable: bool,
}

/// 利用者に見せる選択肢は「写真」と「イラスト」の 2 つだけ。
/// 速さや精度ではなく、**手元にある絵が何か**で選ばせる。
/// 速い／きれい は利用者にトレードオフの判断を求めてしまうが、
/// 写真かイラストかは見れば分かる（SPEC 3.4 の「行為の言葉で書く」）。
pub const MODELS: &[Model] = &[
    Model {
        id: "isnet-general-use",
        file: "isnet-general-use.onnx",
        url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx",
        bytes: 178_648_008,
        input: 1024,
        mean: [0.5, 0.5, 0.5],
        std: [1.0, 1.0, 1.0],
        selectable: true,
    },
    // 子どもが描いた絵やキャラクターのイラストはこちらのほうが安定する
    Model {
        id: "isnet-anime",
        file: "isnet-anime.onnx",
        url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-anime.onnx",
        bytes: 176_069_933,
        input: 1024,
        mean: [0.5, 0.5, 0.5],
        std: [1.0, 1.0, 1.0],
        selectable: true,
    },
    // 4.4MB と軽いので、統合テストではこれを使う。UI には出さない
    Model {
        id: "u2netp",
        file: "u2netp.onnx",
        url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
        bytes: 4_574_861,
        input: 320,
        mean: [0.485, 0.456, 0.406],
        std: [0.229, 0.224, 0.225],
        selectable: false,
    },
];

pub fn model_by_id(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.id == id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub bytes: u64,
    /// すでに手元にあるか。無ければ初回だけダウンロードする
    pub downloaded: bool,
}

fn models_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?.join("models");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub fn list_models(app: AppHandle) -> Result<Vec<ModelInfo>> {
    let dir = models_dir(&app)?;
    Ok(MODELS
        .iter()
        .filter(|m| m.selectable)
        .map(|m| ModelInfo {
            id: m.id.to_string(),
            bytes: m.bytes,
            downloaded: dir.join(m.file).is_file(),
        })
        .collect())
}

// ---------------------------------------------------------------- 進捗

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "stage"
)]
pub enum Progress {
    /// モデルの初回ダウンロード
    Download {
        percent: f64,
        mb: f64,
        total_mb: f64,
    },
    /// モデルの読み込み
    Load,
    /// 推論
    Infer,
    /// 元画像と合成して書き出す
    Compose,
}

/// 進捗の受け口。Channel に縛らず関数で受けることで、テストから呼べるようにする。
/// 3 秒を超える処理では、いま何をしているかを必ず出す（SPEC 11.1）
pub trait Report: Fn(Progress) {}
impl<F: Fn(Progress)> Report for F {}

// ---------------------------------------------------------------- 取得

async fn ensure_model<F: Report>(app: &AppHandle, model: &Model, report: &F) -> Result<PathBuf> {
    let path = models_dir(app)?.join(model.file);
    if path.is_file() {
        return Ok(path);
    }
    download_model(model, &path, report).await?;
    Ok(path)
}

/// モデルを取ってくる。途中で失敗した中身が残らないよう、書き終えてから名前を付ける
async fn download_model<F: Report>(model: &Model, path: &Path, report: &F) -> Result<()> {
    let total = model.bytes as f64;
    report(Progress::Download {
        percent: 0.0,
        mb: 0.0,
        total_mb: total / 1_048_576.0,
    });

    let response = reqwest::get(model.url)
        .await
        .map_err(|e| Error::Download(e.to_string()))?;
    if !response.status().is_success() {
        return Err(Error::Download(format!(
            "{} が取得できませんでした ({})",
            model.id,
            response.status()
        )));
    }

    let tmp = path.with_extension("part");
    let mut file = fs::File::create(&tmp)?;
    let mut got: u64 = 0;
    let mut stream = response.bytes_stream();

    // 受信チャンクごとに送ると、170MB のモデルでは 1 万件を超える IPC が
    // WebView に殺到し、描画が追いつかなくなって画面が固まって見える。
    // 目に見える速さ（0.1 秒）より細かく送っても意味がないので間引く。
    let mut last_sent = Instant::now();
    const INTERVAL: Duration = Duration::from_millis(100);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| Error::Download(e.to_string()))?;
        file.write_all(&chunk)?;
        got += chunk.len() as u64;

        if last_sent.elapsed() >= INTERVAL {
            last_sent = Instant::now();
            report(Progress::Download {
                percent: (got as f64 / total * 100.0).min(100.0),
                mb: got as f64 / 1_048_576.0,
                total_mb: total / 1_048_576.0,
            });
        }
    }
    // 最後に 100% を必ず 1 回送る
    report(Progress::Download {
        percent: 100.0,
        mb: got as f64 / 1_048_576.0,
        total_mb: total / 1_048_576.0,
    });
    file.flush()?;
    drop(file);
    fs::rename(&tmp, path)?;
    Ok(())
}

// ---------------------------------------------------------------- 推論

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MattingOptions {
    /// どのモデルを使うか
    pub model: String,
    /// ふちの締め具合 0〜1。半透明の縁を減らす
    pub edge_tighten: f32,
}

impl Default for MattingOptions {
    fn default() -> Self {
        Self {
            model: "isnet-general-use".to_string(),
            edge_tighten: 0.35,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cutout {
    pub asset_id: String,
    pub path: String,
    pub width_px: u32,
    pub height_px: u32,
}

#[tauri::command]
pub async fn remove_background(
    app: AppHandle,
    path: String,
    options: MattingOptions,
    on_progress: Channel<Progress>,
) -> Result<Cutout> {
    let model =
        model_by_id(&options.model).ok_or_else(|| Error::UnknownModel(options.model.clone()))?;
    let ch = on_progress.clone();
    let report = move |p: Progress| {
        let _ = ch.send(p);
    };
    let model_path = ensure_model(&app, model, &report).await?;

    let src = PathBuf::from(&path);
    let out_dir = app.path().app_cache_dir()?.join("assets");
    fs::create_dir_all(&out_dir)?;

    let edge = options.edge_tighten;

    // 推論は重いので専用スレッドに逃がす。UI を止めない
    tauri::async_runtime::spawn_blocking(move || {
        run(&src, &model_path, model, edge, &out_dir, &report)
    })
    .await
    .map_err(|e| Error::Inference(e.to_string()))?
}

fn run<F: Report>(
    src: &Path,
    model_path: &Path,
    model: &Model,
    edge_tighten: f32,
    out_dir: &Path,
    report: &F,
) -> Result<Cutout> {
    use ort::session::builder::GraphOptimizationLevel;
    use ort::session::Session;
    use ort::value::Tensor;

    report(Progress::Load);
    let session = Session::builder()
        .map_err(inference)?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(inference)?
        .with_intra_threads(num_threads())
        .map_err(inference)?
        .commit_from_file(model_path)
        .map_err(inference)?;

    let original = image::open(src)?;
    let (ow, oh) = original.dimensions();

    // --- 前処理 -------------------------------------------------------
    let side = model.input;
    let small = original
        .resize_exact(side, side, FilterType::Lanczos3)
        .to_rgb8();

    let n = (side * side) as usize;
    let mut input = vec![0f32; n * 3];
    for (i, px) in small.pixels().enumerate() {
        for c in 0..3 {
            let v = f32::from(px.0[c]) / 255.0;
            input[c * n + i] = (v - model.mean[c]) / model.std[c];
        }
    }

    report(Progress::Infer);
    let tensor = Tensor::from_array(([1usize, 3, side as usize, side as usize], input))
        .map_err(inference)?;
    let input_name = session.inputs[0].name.clone();
    let outputs = session
        .run(ort::inputs![input_name.as_str() => tensor].map_err(inference)?)
        .map_err(inference)?;

    let first = session.outputs[0].name.clone();
    let (_shape, pred) = outputs[first.as_str()]
        .try_extract_raw_tensor::<f32>()
        .map_err(inference)?;

    // --- 後処理 -------------------------------------------------------
    // rembg と同じく min-max で 0..1 に伸ばす
    let mut lo = f32::MAX;
    let mut hi = f32::MIN;
    for &v in pred.iter().take(n) {
        lo = lo.min(v);
        hi = hi.max(v);
    }
    let span = if (hi - lo).abs() < f32::EPSILON {
        1.0
    } else {
        hi - lo
    };

    // ふちを締める。半透明の縁が残ると、切ったときに白くにじんで見える
    let k = 1.0 + edge_tighten.clamp(0.0, 1.0) * 2.0;

    let mut mask: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::new(side, side);
    for (i, p) in mask.pixels_mut().enumerate() {
        let v = (pred[i] - lo) / span;
        let v = ((v - 0.5) * k + 0.5).clamp(0.0, 1.0);
        *p = Luma([(v * 255.0).round() as u8]);
    }

    report(Progress::Compose);
    let mask = DynamicImage::ImageLuma8(mask)
        .resize_exact(ow, oh, FilterType::Lanczos3)
        .to_luma8();

    let rgb = original.to_rgb8();
    let mut out: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(ow, oh);
    for (x, y, p) in out.enumerate_pixels_mut() {
        let c = rgb.get_pixel(x, y).0;
        let a = mask.get_pixel(x, y).0[0];
        *p = Rgba([c[0], c[1], c[2], a]);
    }

    let asset_id = new_id();
    let dest = out_dir.join(format!("{asset_id}.cutout.png"));
    out.save(&dest)?;

    Ok(Cutout {
        asset_id,
        path: dest.to_string_lossy().into_owned(),
        width_px: ow,
        height_px: oh,
    })
}

fn num_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
}

fn inference<E: std::fmt::Display>(e: E) -> Error {
    Error::Inference(e.to_string())
}

fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("as_{nanos:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TS 側の MattingProgress と形が食い違うと、画面が固まったように見える。
    /// 実際にそれで詰まったので、JSON の形をテストで固定しておく。
    #[test]
    fn 進捗のjsonがフロントの期待どおり() {
        let d = serde_json::to_value(Progress::Download {
            percent: 12.5,
            mb: 21.0,
            total_mb: 170.4,
        })
        .unwrap();
        assert_eq!(d["stage"], "download");
        assert_eq!(d["percent"], 12.5);
        assert_eq!(d["mb"], 21.0);
        assert_eq!(d["totalMb"], 170.4, "camelCase になっていること");
        assert!(d.get("total_mb").is_none(), "snake_case が残っていないこと");

        for (p, want) in [
            (Progress::Load, "load"),
            (Progress::Infer, "infer"),
            (Progress::Compose, "compose"),
        ] {
            let v = serde_json::to_value(p).unwrap();
            assert_eq!(v["stage"], want);
        }
    }

    #[test]
    fn 選択肢は写真とイラストの二つだけ() {
        let ids: Vec<&str> = MODELS
            .iter()
            .filter(|m| m.selectable)
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, vec!["isnet-general-use", "isnet-anime"]);
        // テスト用の軽いモデルは、選択肢には出さない
        let light = model_by_id("u2netp").expect("テスト用に残してあること");
        assert!(!light.selectable);
    }

    /// 実際にモデルを落として推論まで通す。
    /// 4.4MB のダウンロードと数秒の推論が走るので、既定では動かさない。
    ///   cargo test -- --ignored --nocapture
    #[test]
    #[ignore = "モデルをダウンロードして実際に推論する"]
    fn 背景が消えて中身が残る() {
        let model = model_by_id("u2netp").unwrap();
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-models");
        fs::create_dir_all(&dir).unwrap();
        let model_path = dir.join(model.file);
        if !model_path.is_file() {
            tauri::async_runtime::block_on(download_model(model, &model_path, &|_| {}))
                .expect("モデルを取得できること");
        }

        // 白地の真ん中に赤い丸。前景として拾われるはず
        let side = 256u32;
        let mut img =
            ImageBuffer::<Rgba<u8>, Vec<u8>>::from_pixel(side, side, Rgba([255, 255, 255, 255]));
        let (cx, cy, r) = (side as f32 / 2.0, side as f32 / 2.0, side as f32 * 0.3);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
            if d < r {
                *p = Rgba([220, 30, 30, 255]);
            }
        }
        let work = dir.join("work");
        fs::create_dir_all(&work).unwrap();
        let src = work.join("circle.png");
        img.save(&src).unwrap();

        let cutout = run(&src, &model_path, model, 0.35, &work, &|_| {}).expect("推論が通ること");

        let out = image::open(&cutout.path).unwrap().to_rgba8();
        let center = out.get_pixel(side / 2, side / 2).0[3];
        let corner = out.get_pixel(2, 2).0[3];
        println!("中心のアルファ={center} 隅のアルファ={corner}");

        assert!(center > 128, "丸の中は残るはず: {center}");
        assert!(corner < 128, "背景は消えるはず: {corner}");
        assert!(center as i32 - corner as i32 > 80, "差がはっきり出るはず");
    }

    #[test]
    fn すべてのモデルに入力サイズと正規化がある() {
        for m in MODELS {
            assert!(m.input == 320 || m.input == 1024, "{}", m.id);
            assert!(m.std.iter().all(|s| *s > 0.0), "{}", m.id);
            assert!(m.url.starts_with("https://"), "{}", m.id);
        }
    }
}
