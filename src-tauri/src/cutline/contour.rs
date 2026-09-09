//! 等高線の抽出（マーチングスクエア）。
//!
//! 二値のマスクから画素の境目をたどると、階段状のギザギザが出る。
//! そうではなく、**距離場の等高線**を補間つきで取り出す。
//! 「前景から 3mm の地点」を連ねた線がそのまま切る線になり、
//! 画素の格子に縛られない滑らかな形が得られる。

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// 値が level 以下の領域を「内側」として、その境界を閉じた輪郭で返す。
/// 座標は格子のピクセル単位。
pub fn march(field: &[f32], width: usize, height: usize, level: f32) -> Vec<Vec<Point>> {
    let mut segments: Vec<(Point, Point)> = Vec::new();

    let at = |x: usize, y: usize| field[y * width + x];
    let inside = |v: f32| v <= level;

    // 端で輪郭が開かないよう、格子の外側は「外」として扱う
    for y in 0..height.saturating_sub(1) {
        for x in 0..width.saturating_sub(1) {
            let v0 = at(x, y);
            let v1 = at(x + 1, y);
            let v2 = at(x + 1, y + 1);
            let v3 = at(x, y + 1);

            let mut case = 0u8;
            if inside(v0) {
                case |= 1;
            }
            if inside(v1) {
                case |= 2;
            }
            if inside(v2) {
                case |= 4;
            }
            if inside(v3) {
                case |= 8;
            }
            if case == 0 || case == 15 {
                continue;
            }

            let fx = x as f32;
            let fy = y as f32;
            let lerp = |a: f32, b: f32| -> f32 {
                let d = b - a;
                if d.abs() < 1e-12 {
                    0.5
                } else {
                    ((level - a) / d).clamp(0.0, 1.0)
                }
            };
            let top = Point {
                x: fx + lerp(v0, v1),
                y: fy,
            };
            let right = Point {
                x: fx + 1.0,
                y: fy + lerp(v1, v2),
            };
            let bottom = Point {
                x: fx + lerp(v3, v2),
                y: fy + 1.0,
            };
            let left = Point {
                x: fx,
                y: fy + lerp(v0, v3),
            };

            // 内側がつねに進行方向の右にくるように向きを決める
            match case {
                1 => segments.push((top, left)),
                2 => segments.push((right, top)),
                3 => segments.push((right, left)),
                4 => segments.push((bottom, right)),
                5 => {
                    // 対角だけが内側。真ん中の値でどちらにつながるかを決める
                    if inside((v0 + v1 + v2 + v3) / 4.0) {
                        segments.push((top, right));
                        segments.push((bottom, left));
                    } else {
                        segments.push((top, left));
                        segments.push((bottom, right));
                    }
                }
                6 => segments.push((bottom, top)),
                7 => segments.push((bottom, left)),
                8 => segments.push((left, bottom)),
                9 => segments.push((top, bottom)),
                10 => {
                    if inside((v0 + v1 + v2 + v3) / 4.0) {
                        segments.push((right, bottom));
                        segments.push((left, top));
                    } else {
                        segments.push((right, top));
                        segments.push((left, bottom));
                    }
                }
                11 => segments.push((right, bottom)),
                12 => segments.push((left, right)),
                13 => segments.push((top, right)),
                14 => segments.push((left, top)),
                _ => {}
            }
        }
    }

    link_loops(segments)
}

/// 切れ切れの線分を、端点でつないで閉じた輪郭にする
fn link_loops(segments: Vec<(Point, Point)>) -> Vec<Vec<Point>> {
    use std::collections::HashMap;

    // 浮動小数の端点をそのまま鍵にはできないので、細かい格子に丸めて突き合わせる
    let key =
        |p: Point| -> (i64, i64) { ((p.x * 4096.0).round() as i64, (p.y * 4096.0).round() as i64) };

    let mut starts: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, seg) in segments.iter().enumerate() {
        starts.entry(key(seg.0)).or_default().push(i);
    }

    let mut used = vec![false; segments.len()];
    let mut loops: Vec<Vec<Point>> = Vec::new();

    for start in 0..segments.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut points = vec![segments[start].0, segments[start].1];
        let mut cursor = segments[start].1;

        while let Some(candidates) = starts.get(&key(cursor)) {
            let next = candidates.iter().copied().find(|&i| !used[i]);
            let Some(i) = next else { break };
            used[i] = true;
            cursor = segments[i].1;
            // 出発点に戻ったら閉じる
            if key(cursor) == key(points[0]) {
                break;
            }
            points.push(cursor);
        }

        // 3 点未満は面積を持たないので捨てる
        if points.len() >= 3 {
            loops.push(points);
        }
    }
    loops
}

/// 符号つき面積。外周と穴を見分けるのに使う（画面座標は y が下向き）
pub fn signed_area(points: &[Point]) -> f32 {
    let n = points.len();
    if n < 3 {
        return 0.0;
    }
    let mut sum = 0.0;
    for i in 0..n {
        let a = points[i];
        let b = points[(i + 1) % n];
        sum += a.x * b.y - b.x * a.y;
    }
    sum / 2.0
}

pub fn perimeter(points: &[Point]) -> f32 {
    let n = points.len();
    if n < 2 {
        return 0.0;
    }
    (0..n)
        .map(|i| {
            let a = points[i];
            let b = points[(i + 1) % n];
            ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cutline::mask::Mask;

    /// 半径 r の円を描いたマスクの距離場から等高線を取る
    fn disk_field(size: usize, cx: f32, cy: f32, r: f32) -> (Vec<f32>, usize) {
        let mut m = Mask::new(size, size);
        for y in 0..size {
            for x in 0..size {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                m.set(x, y, d <= r);
            }
        }
        (m.distance_field(), size)
    }

    #[test]
    fn 円の等高線が一本取れる() {
        let (field, size) = disk_field(61, 30.0, 30.0, 10.0);
        let loops = march(&field, size, size, 0.0);
        assert_eq!(loops.len(), 1, "輪郭は 1 本のはず");
        assert!(loops[0].len() > 20, "点の数: {}", loops[0].len());
    }

    #[test]
    fn 広げた等高線は半径ぶん大きくなる() {
        let (field, size) = disk_field(101, 50.0, 50.0, 10.0);
        // 前景から 8 ピクセルの地点＝半径 18 の円になるはず
        let loops = march(&field, size, size, 8.0);
        assert_eq!(loops.len(), 1);

        let pts = &loops[0];
        let max_r = pts
            .iter()
            .map(|p| ((p.x - 50.0).powi(2) + (p.y - 50.0).powi(2)).sqrt())
            .fold(0f32, f32::max);
        let min_r = pts
            .iter()
            .map(|p| ((p.x - 50.0).powi(2) + (p.y - 50.0).powi(2)).sqrt())
            .fold(f32::MAX, f32::min);
        assert!(
            (max_r - 18.0).abs() < 1.0 && (min_r - 18.0).abs() < 1.0,
            "半径 18 前後のはず: {min_r}〜{max_r}"
        );
    }

    #[test]
    fn 穴のある形は外周と穴の二本になる() {
        let size = 81;
        let mut m = Mask::new(size, size);
        for y in 0..size {
            for x in 0..size {
                let d = ((x as f32 - 40.0).powi(2) + (y as f32 - 40.0).powi(2)).sqrt();
                m.set(x, y, (12.0..=30.0).contains(&d));
            }
        }
        let loops = march(&m.distance_field(), size, size, 0.0);
        assert_eq!(loops.len(), 2, "外周と穴で 2 本");

        // 向きが逆になっていれば、符号で外周と穴を見分けられる
        let a = signed_area(&loops[0]);
        let b = signed_area(&loops[1]);
        assert!(a * b < 0.0, "符号が逆のはず: {a} と {b}");
        assert!(
            a.abs().max(b.abs()) > a.abs().min(b.abs()) * 3.0,
            "外周のほうが大きい"
        );
    }

    #[test]
    fn 離れた二つの形は二本になる() {
        let size = 61;
        let mut m = Mask::new(size, size);
        for y in 10..20 {
            for x in 10..20 {
                m.set(x, y, true);
            }
        }
        for y in 40..50 {
            for x in 40..50 {
                m.set(x, y, true);
            }
        }
        let loops = march(&m.distance_field(), size, size, 0.0);
        assert_eq!(loops.len(), 2);
    }
}
