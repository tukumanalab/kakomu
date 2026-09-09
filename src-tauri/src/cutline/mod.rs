//! 切る線の生成（SPEC 7.4）。
//!
//! 入力は絵のアルファ、出力は加工機に渡せるベジェ曲線。
//!
//! # ポリゴンではなく距離場で扱う理由
//!
//! SPEC では Clipper2 でポリゴンをオフセットする想定だったが、
//! 入力がラスタ（アルファ）なので、いったん**距離場**にしたほうが素直だった。
//!
//!   - 角が自然に丸くなる。ユークリッド距離の等高線は角で円弧になるので、
//!     アクリル加工で欲しい丸い角が、特別な処理なしに出る
//!   - **自己交差が原理的に起きない。** 塗り分けた領域は自分と交差しようがない。
//!     SPEC 7.4 の [6] 自己交差の解消は、この方式では不要になった
//!   - 穴の除去も、細い部分の検出も、同じ距離場の上でできる
//!   - C++ の依存が要らない。Windows を含む 3 OS のビルドが単純なままになる
//!
//! # SPEC からもう一つ変えたところ
//!
//! SPEC 7.4 の [7] は「開き（縮めてから広げる）の結果を採用する」と書いてあった。
//! これは**誤り**で、そのまま実装すると細い尻尾やリボンが切り落とされ、
//! 絵が切る線からはみ出してしまう。細い部分は消すのではなく太らせるのが正しい。
//! 詳しくは mask::thicken_thin_parts を参照。

mod contour;
mod edt;
mod fit;
mod mask;
mod simplify;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use contour::Point;
use mask::Mask;

/// 作業に使う解像度。0.0625mm ごとに 1 画素あれば、
/// 最小幅 1.5mm の判定にも、0.02mm の当てはめ誤差にも足りる
const TARGET_PX_PER_MM: f32 = 16.0;
/// 大きな絵でも時間と記憶容量が暴れないよう、一辺の上限を決めておく
const MAX_SIDE_PX: usize = 3000;

/// アクリル加工で折れずに残る最小の幅
const MIN_FEATURE_WIDTH_MM: f32 = 1.5;
/// 刃が入る最小の穴径
const MIN_HOLE_DIAMETER_MM: f32 = 2.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutlineParams {
    /// ふちの太さ
    pub offset_mm: f32,
    /// 0〜255。半透明をどこから前景とみなすか
    pub alpha_threshold: u8,
    /// 0 = 忠実、1 = なめらか
    pub smoothing: f32,
    /// これ未満の孤立した点は無視する
    pub min_area_mm2: f32,
    pub keep_holes: bool,
    /// 折れやすい細い部分を自動で太らせる
    pub enforce_min_width: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub p: [f32; 2],
    /// 入りのハンドル。アンカーからの相対（mm）
    pub r#in: [f32; 2],
    pub out: [f32; 2],
    /// "corner" か "smooth"
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubPath {
    pub closed: bool,
    pub anchors: Vec<Anchor>,
    /// 外周なら false、内側の穴なら true
    pub is_hole: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// 画面の文言は front 側で引く。ここでは種類だけを返す
    pub kind: String,
    /// "error" か "warn"
    pub severity: String,
    /// 見つかった箇所の数、または該当する大きさ
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutlineResult {
    pub subpaths: Vec<SubPath>,
    pub issues: Vec<Issue>,
    /// 当てはめたベジェの本数。減り具合の目安として画面に出せる
    pub segment_count: usize,
}

#[tauri::command]
pub async fn generate_cutline(
    path: String,
    width_mm: f32,
    height_mm: f32,
    params: CutlineParams,
) -> Result<CutlineResult> {
    tauri::async_runtime::spawn_blocking(move || {
        generate(
            &std::path::PathBuf::from(path),
            width_mm,
            height_mm,
            &params,
        )
    })
    .await
    .map_err(|e| Error::Export(e.to_string()))?
}

fn generate(
    src: &std::path::Path,
    width_mm: f32,
    height_mm: f32,
    params: &CutlineParams,
) -> Result<CutlineResult> {
    if width_mm <= 0.0 || height_mm <= 0.0 {
        return Err(Error::Export("絵の大きさが 0 です".into()));
    }

    // --- 作業する格子を決める ------------------------------------------
    let px_per_mm = working_resolution(width_mm, height_mm, params.offset_mm);
    let art_w = ((width_mm * px_per_mm).round() as usize).max(2);
    let art_h = ((height_mm * px_per_mm).round() as usize).max(2);
    // 広げたぶんが格子の外に出ないよう、余白を取る
    let margin = ((params.offset_mm + MIN_FEATURE_WIDTH_MM) * px_per_mm).ceil() as usize + 2;
    let w = art_w + margin * 2;
    let h = art_h + margin * 2;

    // --- [1] アルファ二値化 --------------------------------------------
    let img = image::open(src)?
        .resize_exact(
            art_w as u32,
            art_h as u32,
            image::imageops::FilterType::Lanczos3,
        )
        .to_rgba8();

    let mut m = Mask::new(w, h);
    for (x, y, px) in img.enumerate_pixels() {
        if px.0[3] >= params.alpha_threshold {
            m.set(x as usize + margin, y as usize + margin, true);
        }
    }
    if m.count() == 0 {
        return Err(Error::Export(
            "透明なところしかありません。先に背景を消したか確かめてください".into(),
        ));
    }

    // --- [2] ゴミの除去 -------------------------------------------------
    let min_px = (params.min_area_mm2 * px_per_mm * px_per_mm).round() as usize;
    if min_px > 1 {
        m = m.remove_small_islands(min_px);
    }

    // --- [3] 穴の扱い ---------------------------------------------------
    if !params.keep_holes {
        m = m.fill_holes();
    }

    // --- [4][5] 距離場を作って、ふちの太さぶん広げる ---------------------
    // 角はここで自然に丸くなる。[6] の自己交差の解消は要らない
    let offset_px = params.offset_mm * px_per_mm;
    let mut shape = m.dilate(offset_px);

    // --- [7] 細すぎるところを太らせる -----------------------------------
    let min_width_px = MIN_FEATURE_WIDTH_MM * px_per_mm;
    let thin_before = thin_area(&shape, min_width_px / 2.0);
    if params.enforce_min_width {
        shape = shape.thicken_thin_parts(min_width_px / 2.0);
    }

    // --- 輪郭を取り出す --------------------------------------------------
    let field = shape.distance_field();
    let loops = contour::march(&field, w, h, 0.0);
    if loops.is_empty() {
        return Err(Error::Export("切る線を作れませんでした".into()));
    }

    // --- [8] 間引いてベジェに当てはめる ----------------------------------
    // なめらかさ 0〜1 を 0.05〜0.5mm の許容誤差に対応させる
    let simplify_tolerance_mm = 0.05 + params.smoothing.clamp(0.0, 1.0) * 0.45;
    let simplify_px = simplify_tolerance_mm * px_per_mm;
    // 当てはめのほうは、目で見て直線化が分からない程度に固定する
    let fit_px = 0.02 * px_per_mm;

    let outer_sign = loops
        .iter()
        .map(|l| contour::signed_area(l))
        .max_by(|a, b| a.abs().total_cmp(&b.abs()))
        .map(|a| a.signum())
        .unwrap_or(1.0);

    let mut subpaths = Vec::new();
    let mut segment_count = 0usize;
    let mut hole_diameters_mm: Vec<f32> = Vec::new();

    for l in &loops {
        let area = contour::signed_area(l);
        let is_hole = area.signum() != outer_sign;
        if is_hole && !params.keep_holes {
            continue;
        }
        if is_hole {
            hole_diameters_mm.push(2.0 * (area.abs() / std::f32::consts::PI).sqrt() / px_per_mm);
        }
        // 1 周が短すぎるものは形として意味がない
        if contour::perimeter(l) < px_per_mm {
            continue;
        }

        let simplified = simplify::simplify_closed(l, simplify_px);
        let corners = simplify::find_corners(&simplified, 60.0);
        let curves = fit_loop(&simplified, &corners, fit_px);
        segment_count += curves.len();

        if let Some(anchors) = to_anchors(&curves, &corners, px_per_mm, margin as f32) {
            subpaths.push(SubPath {
                closed: true,
                anchors,
                is_hole,
            });
        }
    }

    if subpaths.is_empty() {
        return Err(Error::Export("切る線を作れませんでした".into()));
    }

    // --- 検査 -------------------------------------------------------------
    let mut issues = Vec::new();
    let thin_after = thin_area(&shape, min_width_px / 2.0);
    if thin_after > 0 {
        issues.push(Issue {
            kind: "minWidth".into(),
            severity: "error".into(),
            detail: None,
        });
    } else if thin_before > 0 && params.enforce_min_width {
        // 直した、と伝えるほうが「なぜ形が変わったのか」が分かる
        issues.push(Issue {
            kind: "minWidthFixed".into(),
            severity: "warn".into(),
            detail: None,
        });
    }
    for d in &hole_diameters_mm {
        if *d < MIN_HOLE_DIAMETER_MM {
            issues.push(Issue {
                kind: "minHole".into(),
                severity: "error".into(),
                detail: Some(format!("{d:.1}")),
            });
            break;
        }
    }

    Ok(CutlineResult {
        subpaths,
        issues,
        segment_count,
    })
}

/// 絵の大きさに対して細かすぎない解像度を選ぶ
fn working_resolution(width_mm: f32, height_mm: f32, offset_mm: f32) -> f32 {
    let long_mm = width_mm.max(height_mm) + offset_mm * 2.0;
    let wanted = long_mm * TARGET_PX_PER_MM;
    if wanted <= MAX_SIDE_PX as f32 {
        TARGET_PX_PER_MM
    } else {
        MAX_SIDE_PX as f32 / long_mm
    }
}

/// 半径 r の円が通れない部分の画素数
fn thin_area(shape: &Mask, r: f32) -> usize {
    shape.difference(&shape.erode(r).dilate(r)).count()
}

/// 角で区切って当てはめる。角をまたぐと丸まってしまう
fn fit_loop(points: &[Point], corners: &[usize], tolerance: f32) -> Vec<fit::Cubic> {
    let n = points.len();
    if n < 3 {
        return Vec::new();
    }
    if corners.is_empty() {
        let mut closed = points.to_vec();
        closed.push(points[0]);
        return fit::fit(&closed, tolerance);
    }

    let mut out = Vec::new();
    for w in 0..corners.len() {
        let a = corners[w];
        let b = corners[(w + 1) % corners.len()];
        let mut span: Vec<Point> = Vec::new();
        let mut i = a;
        loop {
            span.push(points[i]);
            if i == b {
                break;
            }
            i = (i + 1) % n;
        }
        out.extend(fit::fit(&span, tolerance));
    }
    out
}

/// ベジェ列を、アンカーとハンドルの形に直す。座標は絵のローカル mm
fn to_anchors(
    curves: &[fit::Cubic],
    corners: &[usize],
    px_per_mm: f32,
    margin: f32,
) -> Option<Vec<Anchor>> {
    if curves.is_empty() {
        return None;
    }
    let to_mm = |p: Point| -> [f32; 2] { [(p.x - margin) / px_per_mm, (p.y - margin) / px_per_mm] };

    let n = curves.len();
    let mut anchors = Vec::with_capacity(n);
    for i in 0..n {
        let cur = &curves[i];
        let prev = &curves[(i + n - 1) % n];
        let p = to_mm(cur.p0);
        let out = to_mm(cur.c1);
        let inp = to_mm(prev.c2);
        anchors.push(Anchor {
            p,
            r#in: [inp[0] - p[0], inp[1] - p[1]],
            out: [out[0] - p[0], out[1] - p[1]],
            // 角で区切って当てはめているので、区切り目が角にあたる
            kind: if corners.is_empty() {
                "smooth"
            } else {
                "corner"
            }
            .into(),
        });
    }
    Some(anchors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn write_disk(path: &std::path::Path, size: u32, r: f32) {
        let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_fn(size, size, |x, y| {
            let c = size as f32 / 2.0;
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            if d <= r {
                Rgba([200, 40, 40, 255])
            } else {
                Rgba([0, 0, 0, 0])
            }
        });
        img.save(path).unwrap();
    }

    fn params() -> CutlineParams {
        CutlineParams {
            offset_mm: 3.0,
            alpha_threshold: 128,
            smoothing: 0.5,
            min_area_mm2: 4.0,
            keep_holes: false,
            enforce_min_width: true,
        }
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("kakomu-cutline-test");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn 丸い絵からは丸い線ができて三ミリ外側にある() {
        // 40mm 四方に、直径 20mm の丸
        let src = tmp("disk.png");
        write_disk(&src, 400, 100.0);
        let r = generate(&src, 40.0, 40.0, &params()).unwrap();

        assert_eq!(r.subpaths.len(), 1, "輪郭は 1 本");
        let anchors = &r.subpaths[0].anchors;
        assert!(!anchors.is_empty());

        // 絵の中心は (20, 20)mm、絵の半径は 10mm。切る線は 13mm のはず
        let radii: Vec<f32> = anchors
            .iter()
            .map(|a| ((a.p[0] - 20.0).powi(2) + (a.p[1] - 20.0).powi(2)).sqrt())
            .collect();
        let min = radii.iter().cloned().fold(f32::MAX, f32::min);
        let max = radii.iter().cloned().fold(0.0, f32::max);
        assert!(
            (min - 13.0).abs() < 0.4 && (max - 13.0).abs() < 0.4,
            "半径 13mm 前後のはず: {min}〜{max}"
        );
    }

    #[test]
    fn ふちの太さを変えると線も動く() {
        let src = tmp("disk2.png");
        write_disk(&src, 400, 100.0);

        let mut p = params();
        p.offset_mm = 6.0;
        let r = generate(&src, 40.0, 40.0, &p).unwrap();
        let radius = r.subpaths[0]
            .anchors
            .iter()
            .map(|a| ((a.p[0] - 20.0).powi(2) + (a.p[1] - 20.0).powi(2)).sqrt())
            .fold(0.0f32, f32::max);
        assert!((radius - 16.0).abs() < 0.5, "半径 16mm のはず: {radius}");
    }

    #[test]
    fn 点の数がベジェで大きく減る() {
        let src = tmp("disk3.png");
        write_disk(&src, 400, 100.0);
        let r = generate(&src, 40.0, 40.0, &params()).unwrap();
        // 等高線の生の点は数百あるが、曲線は十数本で足りる
        assert!(
            r.segment_count < 20,
            "曲線が {} 本。減っていない",
            r.segment_count
        );
    }

    #[test]
    fn 透明だけの絵は理由を返す() {
        let src = tmp("empty.png");
        let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_pixel(64, 64, Rgba([0, 0, 0, 0]));
        img.save(&src).unwrap();
        let err = generate(&src, 40.0, 40.0, &params()).unwrap_err();
        assert!(err.to_string().contains("透明"), "{err}");
    }

    #[test]
    fn 小さすぎるゴミは無視される() {
        let src = tmp("speck.png");
        let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_fn(400, 400, |x, y| {
            let d = ((x as f32 - 200.0).powi(2) + (y as f32 - 200.0).powi(2)).sqrt();
            // 大きな丸と、離れたところに 2 画素のゴミ
            if d <= 100.0 || ((380..=381).contains(&x) && (380..=381).contains(&y)) {
                Rgba([200, 40, 40, 255])
            } else {
                Rgba([0, 0, 0, 0])
            }
        });
        img.save(&src).unwrap();
        let r = generate(&src, 40.0, 40.0, &params()).unwrap();
        assert_eq!(r.subpaths.len(), 1, "ゴミを拾っていない");
    }

    #[test]
    fn 細い首は太らせて直したと知らせる() {
        // 2 つの丸を、細い橋でつないだ形
        let src = tmp("neck.png");
        let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_fn(400, 400, |x, y| {
            let d1 = ((x as f32 - 200.0).powi(2) + (y as f32 - 110.0).powi(2)).sqrt();
            let d2 = ((x as f32 - 200.0).powi(2) + (y as f32 - 290.0).powi(2)).sqrt();
            let bridge = (198..=201).contains(&x) && (110..=290).contains(&y);
            if d1 <= 60.0 || d2 <= 60.0 || bridge {
                Rgba([200, 40, 40, 255])
            } else {
                Rgba([0, 0, 0, 0])
            }
        });
        img.save(&src).unwrap();

        let mut p = params();
        p.offset_mm = 1.0; // 橋が細いままになるよう、ふちは薄く
        let r = generate(&src, 40.0, 40.0, &p).unwrap();
        // 直したか、直しきれず error として残っているかのどちらかが出る
        assert!(
            r.issues.iter().any(|i| i.kind.starts_with("minWidth")),
            "細さについて何も言っていない: {:?}",
            r.issues
        );
    }
}
