//! ユークリッド距離変換。
//!
//! 「この点から、いちばん近い前景まで何ピクセルか」を全画素について求める。
//! 切る線の生成はほぼこれで決まる:
//!
//!   - 3mm 外側に広げる → 距離が 3mm 以下の場所を新しい形とする
//!   - 角が自然に丸くなる → ユークリッド距離の等高線は角で円弧になる
//!   - 自己交差が起きない → 塗り分けた領域は自分と交差しようがない
//!
//! Felzenszwalb と Huttenlocher の方法。1 次元の変換を行と列に順に当てると
//! 厳密な 2 次元の距離が得られる。画素数に比例する時間で終わる。

const INF: f32 = 1e20;

/// 二値マスクから、前景（true）までの距離の 2 乗を求める
pub fn squared_distance(mask: &[bool], width: usize, height: usize) -> Vec<f32> {
    let mut f = vec![0f32; width * height];
    for (i, &on) in mask.iter().enumerate() {
        f[i] = if on { 0.0 } else { INF };
    }
    transform_2d(&mut f, width, height);
    f
}

/// 距離そのもの（ピクセル単位）
pub fn distance(mask: &[bool], width: usize, height: usize) -> Vec<f32> {
    let mut d = squared_distance(mask, width, height);
    for v in &mut d {
        *v = v.sqrt();
    }
    d
}

fn transform_2d(f: &mut [f32], width: usize, height: usize) {
    // 列ごと
    let mut column = vec![0f32; height];
    for x in 0..width {
        for y in 0..height {
            column[y] = f[y * width + x];
        }
        let out = transform_1d(&column);
        for y in 0..height {
            f[y * width + x] = out[y];
        }
    }
    // 行ごと
    let mut row = vec![0f32; width];
    for y in 0..height {
        row.copy_from_slice(&f[y * width..(y + 1) * width]);
        let out = transform_1d(&row);
        f[y * width..(y + 1) * width].copy_from_slice(&out);
    }
}

/// 1 次元の距離変換。下向きに開いた放物線の下側の包絡線を求めている
fn transform_1d(f: &[f32]) -> Vec<f32> {
    let n = f.len();
    let mut d = vec![0f32; n];
    if n == 0 {
        return d;
    }

    // v[k] = k 番目の放物線の頂点の位置、z[k] = 放物線どうしの交点
    let mut v = vec![0usize; n];
    let mut z = vec![0f32; n + 1];
    let mut k = 0usize;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;

    for q in 1..n {
        let mut s;
        loop {
            let vk = v[k];
            s = ((f[q] + (q * q) as f32) - (f[vk] + (vk * vk) as f32))
                / (2.0 * q as f32 - 2.0 * vk as f32);
            if s > z[k] {
                break;
            }
            // この放物線は前のものに完全に隠れるので捨てる
            if k == 0 {
                break;
            }
            k -= 1;
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
    }

    let mut k = 0usize;
    for (q, out) in d.iter_mut().enumerate() {
        while z[k + 1] < q as f32 {
            k += 1;
        }
        let vk = v[k];
        let dq = q as f32 - vk as f32;
        *out = dq * dq + f[vk];
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 5x5 の真ん中だけ前景。距離が同心円状に増えるはず
    #[test]
    fn 中心から同心円状に距離が増える() {
        let w = 5;
        let h = 5;
        let mut mask = vec![false; w * h];
        mask[2 * w + 2] = true;
        let d = distance(&mask, w, h);

        assert!((d[2 * w + 2] - 0.0).abs() < 1e-4, "中心は 0");
        assert!((d[2 * w + 1] - 1.0).abs() < 1e-4, "隣は 1");
        assert!(
            (d[w + 1] - 2f32.sqrt()).abs() < 1e-4,
            "斜め隣は √2 = {}",
            d[w + 1]
        );
        assert!((d[2 * w] - 2.0).abs() < 1e-4, "2 つ隣は 2");
    }

    #[test]
    fn 前景が無ければ全部遠い() {
        let d = distance(&[false; 9], 3, 3);
        assert!(d.iter().all(|v| *v > 1e5), "どこからも遠いはず");
    }

    #[test]
    fn 全部前景なら全部ゼロ() {
        let d = distance(&[true; 9], 3, 3);
        assert!(d.iter().all(|v| *v == 0.0));
    }

    /// 縦一列が前景なら、距離は横方向の距離だけで決まる
    #[test]
    fn 直線からの距離は横のずれで決まる() {
        let w = 7;
        let h = 3;
        let mut mask = vec![false; w * h];
        for y in 0..h {
            mask[y * w + 3] = true;
        }
        let d = distance(&mask, w, h);
        for y in 0..h {
            for x in 0..w {
                let want = (x as f32 - 3.0).abs();
                assert!(
                    (d[y * w + x] - want).abs() < 1e-4,
                    "({x},{y}) は {want} のはずが {}",
                    d[y * w + x]
                );
            }
        }
    }
}
