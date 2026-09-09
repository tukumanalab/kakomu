//! 点列の間引きと、角の検出。
//!
//! 等高線はそのままだと点が多すぎる。ベジェに直す前に、
//! 形を保ったまま点を減らす（Ramer–Douglas–Peucker）。
//!
//! あわせて、曲線として滑らかにつなぐべきでない「角」を見つけておく。
//! 角をまたいで 1 本の曲線を当てはめると、角が丸まって別の形になってしまう。

use super::contour::Point;

/// 許容誤差 tolerance ピクセル以内で点を減らす。閉じた輪郭を前提とする。
///
/// RDP は端点を必ず残すので、始点をどこに置くかで結果が変わる。
/// 重心からいちばん遠い点＝形の特徴がある場所を始点にすると、
/// そこが不用意に削られない。
pub fn simplify_closed(points: &[Point], tolerance: f32) -> Vec<Point> {
    if points.len() < 4 || tolerance <= 0.0 {
        return points.to_vec();
    }
    let start = extreme_index(points);
    let mut chain: Vec<Point> = points[start..].to_vec();
    chain.extend_from_slice(&points[..start]);
    chain.push(chain[0]); // いったん開いた線として扱う

    let mut out = rdp(&chain, tolerance);
    out.pop(); // 末尾に足した始点の重複を戻す
    out
}

/// 重心からいちばん遠い点
fn extreme_index(points: &[Point]) -> usize {
    let n = points.len() as f32;
    let cx = points.iter().map(|p| p.x).sum::<f32>() / n;
    let cy = points.iter().map(|p| p.y).sum::<f32>() / n;
    let center = Point { x: cx, y: cy };
    points
        .iter()
        .enumerate()
        .max_by(|a, b| dist2(center, *a.1).total_cmp(&dist2(center, *b.1)))
        .map(|(i, _)| i)
        .unwrap_or(0)
}

fn rdp(points: &[Point], tolerance: f32) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let first = points[0];
    let last = points[points.len() - 1];

    let mut worst = 0.0f32;
    let mut index = 0usize;
    for (i, p) in points.iter().enumerate().take(points.len() - 1).skip(1) {
        let d = distance_to_segment(*p, first, last);
        if d > worst {
            worst = d;
            index = i;
        }
    }

    if worst <= tolerance {
        return vec![first, last];
    }
    let mut left = rdp(&points[..=index], tolerance);
    let right = rdp(&points[index..], tolerance);
    left.pop();
    left.extend(right);
    left
}

fn distance_to_segment(p: Point, a: Point, b: Point) -> f32 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-12 {
        return dist2(p, a).sqrt();
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0);
    let proj = Point {
        x: a.x + t * dx,
        y: a.y + t * dy,
    };
    dist2(p, proj).sqrt()
}

fn dist2(a: Point, b: Point) -> f32 {
    (a.x - b.x).powi(2) + (a.y - b.y).powi(2)
}

/// 隣り合う辺の向きの差が threshold_deg を超える点を「角」とする。
/// ここで曲線を切らないと、角が丸まって別の形になる
pub fn find_corners(points: &[Point], threshold_deg: f32) -> Vec<usize> {
    let n = points.len();
    if n < 3 {
        return Vec::new();
    }
    let limit = threshold_deg.to_radians();
    let mut corners = Vec::new();
    for i in 0..n {
        let prev = points[(i + n - 1) % n];
        let cur = points[i];
        let next = points[(i + 1) % n];

        let a = (cur.x - prev.x, cur.y - prev.y);
        let b = (next.x - cur.x, next.y - cur.y);
        let la = (a.0 * a.0 + a.1 * a.1).sqrt();
        let lb = (b.0 * b.0 + b.1 * b.1).sqrt();
        if la < 1e-6 || lb < 1e-6 {
            continue;
        }
        let cos = ((a.0 * b.0 + a.1 * b.1) / (la * lb)).clamp(-1.0, 1.0);
        if cos.acos() > limit {
            corners.push(i);
        }
    }
    corners
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f32, y: f32) -> Point {
        Point { x, y }
    }

    #[test]
    fn 直線上の点は落ちる() {
        let line = vec![
            p(0.0, 0.0),
            p(1.0, 0.0),
            p(2.0, 0.0),
            p(3.0, 0.0),
            p(4.0, 0.0),
        ];
        let out = rdp(&line, 0.1);
        assert_eq!(out.len(), 2, "端の 2 点だけ残る");
    }

    #[test]
    fn 出っぱりは残る() {
        let line = vec![
            p(0.0, 0.0),
            p(1.0, 0.0),
            p(2.0, 5.0),
            p(3.0, 0.0),
            p(4.0, 0.0),
        ];
        let out = rdp(&line, 0.5);
        assert!(out.len() >= 3, "山の頂点が残る");
        assert!(out.iter().any(|q| q.y > 4.0));
    }

    #[test]
    fn 閉じた四角は四隅だけになる() {
        // 各辺を細かく刻んだ正方形
        let mut pts = Vec::new();
        for i in 0..20 {
            pts.push(p(i as f32, 0.0));
        }
        for i in 0..20 {
            pts.push(p(20.0, i as f32));
        }
        for i in 0..20 {
            pts.push(p(20.0 - i as f32, 20.0));
        }
        for i in 0..20 {
            pts.push(p(0.0, 20.0 - i as f32));
        }
        let out = simplify_closed(&pts, 0.5);
        assert!(out.len() <= 6, "四隅前後まで減るはず: {}", out.len());
        assert!(out.len() >= 4);
    }

    #[test]
    fn 四角の角が見つかる() {
        let square = vec![p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)];
        let corners = find_corners(&square, 60.0);
        assert_eq!(corners.len(), 4, "90 度の角が 4 つ");
    }

    #[test]
    fn なだらかな線に角は無い() {
        // 円周上の点。隣り合う辺の差は小さい
        let pts: Vec<Point> = (0..64)
            .map(|i| {
                let t = i as f32 / 64.0 * std::f32::consts::TAU;
                p(t.cos() * 50.0, t.sin() * 50.0)
            })
            .collect();
        assert!(find_corners(&pts, 60.0).is_empty());
    }
}
