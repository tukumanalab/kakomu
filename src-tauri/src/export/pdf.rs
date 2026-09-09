//! 印刷するデータ（PDF）の書き出し。
//!
//! 出力先は Roland VersaSTUDIO BD-8 + VersaWorks 7（SPEC 8.2）。
//! 白版は VersaWorks が自動生成するので、ここでは作らない（SPEC 8.3）。
//!
//! ライブラリを使わず自前で書いている。理由は、この用途で必要なのが
//! 「1 ページ・画像・透過・箱（TrimBox / BleedBox）」だけであり、
//! そのぶん**箱と配置行列を正確に制御できること**のほうが大事なため。
//! 版ズレや実寸のズレは刷ってからでは直せない。

use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;
use image::imageops::FilterType;
use image::GenericImageView;

use crate::error::{Error, Result};

/// PDF のユーザー空間は 1/72 インチ
const PT_PER_MM: f64 = 72.0 / 25.4;

fn pt(mm: f64) -> f64 {
    mm * PT_PER_MM
}

/// 画像 1 枚の配置。座標はすべて mm、原点は仕上がりの左上、y は下向き
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    /// 元画像（または背景を消した結果）のファイルパス
    pub path: String,
    /// 「平行移動 × 回転」の affine [a, b, c, d, e, f]
    pub transform: [f64; 6],
    pub width_mm: f64,
    pub height_mm: f64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSpec {
    pub width_mm: f64,
    pub height_mm: f64,
    pub bleed_mm: f64,
    /// これを超える解像度の画像は、ここまで落として埋め込む
    pub target_dpi: f64,
    pub images: Vec<Placement>,
}

pub fn write_pdf(spec: &PageSpec, out: &std::path::Path) -> Result<()> {
    let page_w = spec.width_mm + spec.bleed_mm * 2.0;
    let page_h = spec.height_mm + spec.bleed_mm * 2.0;

    let mut objects: Vec<Vec<u8>> = Vec::new();
    // 1..=4 は目次・ページ・内容で予約し、画像は 5 番以降に置く
    let mut xobjects = String::new();
    let mut content = String::new();
    let mut image_objects: Vec<Vec<u8>> = Vec::new();
    let mut next_id = 5usize;

    for (i, place) in spec.images.iter().enumerate() {
        let name = format!("Im{i}");
        let decoded = load_image(place, spec.target_dpi)?;

        let img_id = next_id;
        next_id += 1;
        let smask_id = if decoded.alpha.is_some() {
            let id = next_id;
            next_id += 1;
            Some(id)
        } else {
            None
        };

        image_objects.push(image_xobject(
            decoded.width,
            decoded.height,
            &decoded.rgb,
            smask_id,
        )?);
        if let Some(a) = decoded.alpha {
            image_objects.push(gray_xobject(decoded.width, decoded.height, &a)?);
        }

        xobjects.push_str(&format!("/{name} {img_id} 0 R "));
        content.push_str(&placement_operators(&name, place, spec));
    }

    // --- 1: 目次 -----------------------------------------------------
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());

    // --- 2: ページの入れ物 -------------------------------------------
    objects.push(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec());

    // --- 3: ページ本体 -----------------------------------------------
    // TrimBox が仕上がり、BleedBox が塗り足しを含めた外側。
    // ここがずれると、刷ってから初めて分かる事故になる。
    let bleed = pt(spec.bleed_mm);
    let page = format!(
        "<< /Type /Page /Parent 2 0 R \
         /MediaBox [0 0 {mw:.4} {mh:.4}] \
         /BleedBox [0 0 {mw:.4} {mh:.4}] \
         /TrimBox [{bx:.4} {by:.4} {tx:.4} {ty:.4}] \
         /Resources << /XObject << {xo}>> >> \
         /Contents 4 0 R >>",
        mw = pt(page_w),
        mh = pt(page_h),
        bx = bleed,
        by = bleed,
        tx = bleed + pt(spec.width_mm),
        ty = bleed + pt(spec.height_mm),
        xo = xobjects,
    );
    objects.push(page.into_bytes());

    // --- 4: 内容 ------------------------------------------------------
    let stream = content.into_bytes();
    let mut contents = format!("<< /Length {} >>\nstream\n", stream.len()).into_bytes();
    contents.extend_from_slice(&stream);
    contents.extend_from_slice(b"\nendstream");
    objects.push(contents);

    objects.extend(image_objects);

    let bytes = assemble(&objects);
    std::fs::write(out, bytes)?;
    Ok(())
}

/// 埋め込む用にほどいた画像
struct Decoded {
    rgb: Vec<u8>,
    /// 透過があるときだけ。無い画像に SMask を付けても無駄なので
    alpha: Option<Vec<u8>>,
    width: u32,
    height: u32,
}

/// 画像を読み、必要なら解像度を落として RGB と アルファに分ける
fn load_image(place: &Placement, target_dpi: f64) -> Result<Decoded> {
    let img = image::open(&place.path)?;
    let (mut w, mut h) = img.dimensions();

    // 配置サイズに対して細かすぎる画像は、無駄に重いだけなので落とす
    if place.width_mm > 0.0 {
        let effective_dpi = f64::from(w) / place.width_mm * 25.4;
        if effective_dpi > target_dpi {
            let scale = target_dpi / effective_dpi;
            w = ((f64::from(w) * scale).round() as u32).max(1);
            h = ((f64::from(h) * scale).round() as u32).max(1);
        }
    }
    let img = if (w, h) != img.dimensions() {
        img.resize_exact(w, h, FilterType::Lanczos3)
    } else {
        img
    };

    let rgba = img.to_rgba8();
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    let mut alpha = Vec::with_capacity((w * h) as usize);
    let mut has_transparency = false;
    for p in rgba.pixels() {
        rgb.extend_from_slice(&p.0[0..3]);
        alpha.push(p.0[3]);
        if p.0[3] != 255 {
            has_transparency = true;
        }
    }
    Ok(Decoded {
        rgb,
        alpha: if has_transparency { Some(alpha) } else { None },
        width: w,
        height: h,
    })
}

/// 画像を置く座標変換。
///
/// PDF は原点が左下で y が上向き、ドキュメントは原点が左上で y が下向き。
/// さらに PDF の画像は単位正方形に描かれ、その上端が画像の 1 行目にあたる。
/// この 2 つのねじれをまとめて 1 つの行列にする。
fn placement_operators(name: &str, place: &Placement, spec: &PageSpec) -> String {
    let [a, b, c, d, e, f] = place.transform;
    let w = place.width_mm;
    let h = place.height_mm;
    let bleed = spec.bleed_mm;

    // 単位正方形 (u, v) → ドキュメント → PDF
    let m = [
        a * w,
        -b * w,
        -c * h,
        d * h,
        bleed + c * h + e,
        spec.height_mm + bleed - d * h - f,
    ];

    format!(
        "q {:.4} {:.4} {:.4} {:.4} {:.4} {:.4} cm /{} Do Q\n",
        m[0] * PT_PER_MM,
        m[1] * PT_PER_MM,
        m[2] * PT_PER_MM,
        m[3] * PT_PER_MM,
        pt(m[4]),
        pt(m[5]),
        name,
    )
}

fn image_xobject(w: u32, h: u32, rgb: &[u8], smask: Option<usize>) -> Result<Vec<u8>> {
    let data = deflate(rgb)?;
    let smask_entry = smask
        .map(|id| format!("/SMask {id} 0 R "))
        .unwrap_or_default();
    let mut obj = format!(
        "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} \
         /ColorSpace /DeviceRGB /BitsPerComponent 8 {smask_entry}\
         /Filter /FlateDecode /Length {} >>\nstream\n",
        data.len()
    )
    .into_bytes();
    obj.extend_from_slice(&data);
    obj.extend_from_slice(b"\nendstream");
    Ok(obj)
}

/// 透過を表す層。PDF では SMask として本体の画像から参照する
fn gray_xobject(w: u32, h: u32, gray: &[u8]) -> Result<Vec<u8>> {
    let data = deflate(gray)?;
    let mut obj = format!(
        "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} \
         /ColorSpace /DeviceGray /BitsPerComponent 8 \
         /Filter /FlateDecode /Length {} >>\nstream\n",
        data.len()
    )
    .into_bytes();
    obj.extend_from_slice(&data);
    obj.extend_from_slice(b"\nendstream");
    Ok(obj)
}

fn deflate(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(bytes)
        .map_err(|e| Error::Export(e.to_string()))?;
    enc.finish().map_err(|e| Error::Export(e.to_string()))
}

/// オブジェクトを並べ、相互参照表（xref）を付けて 1 つのファイルにする
fn assemble(objects: &[Vec<u8>]) -> Vec<u8> {
    let mut out: Vec<u8> = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());

    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }

    let xref_at = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for off in &offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
            objects.len() + 1,
            xref_at
        )
        .as_bytes(),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn spec_with(images: Vec<Placement>) -> PageSpec {
        PageSpec {
            width_mm: 80.0,
            height_mm: 120.0,
            bleed_mm: 3.0,
            target_dpi: 600.0,
            images,
        }
    }

    #[test]
    fn 箱の大きさが実寸どおり() {
        let dir = std::env::temp_dir().join("kakomu-pdf-test");
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("boxes.pdf");
        write_pdf(&spec_with(vec![]), &out).unwrap();
        let text = String::from_utf8_lossy(&std::fs::read(&out).unwrap()).into_owned();

        // 86 × 126mm（仕上がり + 塗り足し 3mm）が 1mm = 72/25.4pt で入る
        assert!(
            text.contains("/MediaBox [0 0 243.7795 357.1654]"),
            "MediaBox が実寸でない:\n{}",
            &text[..400.min(text.len())]
        );
        // TrimBox は塗り足しのぶん内側
        assert!(
            text.contains("/TrimBox [8.5039 8.5039 235.2756 348.6614]"),
            "TrimBox がずれている"
        );
    }

    #[test]
    fn 透過のある画像には透過の層が付く() {
        let dir = std::env::temp_dir().join("kakomu-pdf-test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("half.png");
        let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_fn(8, 8, |x, _| {
            Rgba([255, 0, 0, if x < 4 { 0 } else { 255 }])
        });
        img.save(&src).unwrap();

        let out = dir.join("alpha.pdf");
        write_pdf(
            &spec_with(vec![Placement {
                path: src.to_string_lossy().into_owned(),
                transform: [1.0, 0.0, 0.0, 1.0, 10.0, 20.0],
                width_mm: 40.0,
                height_mm: 40.0,
            }]),
            &out,
        )
        .unwrap();
        let text = String::from_utf8_lossy(&std::fs::read(&out).unwrap()).into_owned();
        assert!(text.contains("/SMask"), "透過が落ちている");
        assert!(text.contains("/DeviceGray"), "透過の層が無い");
    }

    #[test]
    fn 回転していない画像は素直な位置に置かれる() {
        // 左上 (10, 20) に 40×40mm。PDF では左下原点なので
        // y = 120 + 3 - 40 - 20 = 63mm のところに来る
        let place = Placement {
            path: String::new(),
            transform: [1.0, 0.0, 0.0, 1.0, 10.0, 20.0],
            width_mm: 40.0,
            height_mm: 40.0,
        };
        let ops = placement_operators("Im0", &place, &spec_with(vec![]));
        let nums: Vec<f64> = ops
            .split_whitespace()
            .filter_map(|t| t.parse::<f64>().ok())
            .collect();
        assert!((nums[0] - pt(40.0)).abs() < 0.01, "横幅: {:?}", nums);
        assert!((nums[3] - pt(40.0)).abs() < 0.01, "高さ: {:?}", nums);
        assert!((nums[4] - pt(13.0)).abs() < 0.01, "左端: {:?}", nums);
        assert!((nums[5] - pt(63.0)).abs() < 0.01, "下端: {:?}", nums);
    }
}
