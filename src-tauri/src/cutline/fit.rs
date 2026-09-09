//! 点列を三次ベジェに当てはめる（Schneider の方法）。
//!
//! 手順は素直で、
//!   1. 両端の接線方向を決める
//!   2. 最小二乗で制御点を求める
//!   3. いちばんずれている点を測る
//!   4. 許容誤差に収まらなければ、媒介変数を調整してやり直す
//!   5. それでもだめなら、いちばんずれている点で 2 つに割って再帰する
//!
//! 点をそのまま折れ線で出すこともできるが、それだと加工機のパスが
//! 何千点にもなり、扱いにくいうえに切削も滑らかにならない。

use super::contour::Point;

#[derive(Debug, Clone, Copy)]
pub struct Cubic {
    pub p0: Point,
    pub c1: Point,
    pub c2: Point,
    pub p1: Point,
}

/// 点列にベジェ列を当てはめる。tolerance はピクセル単位の許容誤差
pub fn fit(points: &[Point], tolerance: f32) -> Vec<Cubic> {
    let pts = dedup(points);
    if pts.len() < 2 {
        return Vec::new();
    }
    if pts.len() == 2 {
        return vec![straight(pts[0], pts[1])];
    }
    let t0 = normalize(sub(pts[1], pts[0]));
    let t1 = normalize(sub(pts[pts.len() - 2], pts[pts.len() - 1]));
    let mut out = Vec::new();
    fit_cubic(&pts, t0, t1, tolerance, 0, &mut out);
    out
}

const MAX_DEPTH: usize = 12;
const REPARAM_TRIES: usize = 4;

fn fit_cubic(
    pts: &[Point],
    t0: (f32, f32),
    t1: (f32, f32),
    tolerance: f32,
    depth: usize,
    out: &mut Vec<Cubic>,
) {
    if pts.len() == 2 {
        out.push(straight(pts[0], pts[1]));
        return;
    }

    let mut u = chord_length_parameters(pts);
    let mut curve = generate(pts, &u, t0, t1);
    let (mut error, mut split) = max_error(pts, &curve, &u);

    if error <= tolerance {
        out.push(curve);
        return;
    }

    // 少しのずれなら、媒介変数を調整するだけで収まることが多い
    if error <= tolerance * 4.0 {
        for _ in 0..REPARAM_TRIES {
            reparameterize(pts, &curve, &mut u);
            curve = generate(pts, &u, t0, t1);
            let (e, s) = max_error(pts, &curve, &u);
            error = e;
            split = s;
            if error <= tolerance {
                out.push(curve);
                return;
            }
        }
    }

    if depth >= MAX_DEPTH || split == 0 || split >= pts.len() - 1 {
        out.push(curve);
        return;
    }

    // いちばんずれている点で割る。割れ目では両側の向きを揃えて滑らかにつなぐ
    let center = normalize((
        pts[split - 1].x - pts[split + 1].x,
        pts[split - 1].y - pts[split + 1].y,
    ));
    fit_cubic(&pts[..=split], t0, center, tolerance, depth + 1, out);
    fit_cubic(
        &pts[split..],
        (-center.0, -center.1),
        t1,
        tolerance,
        depth + 1,
        out,
    );
}

fn straight(a: Point, b: Point) -> Cubic {
    let third = 1.0 / 3.0;
    Cubic {
        p0: a,
        c1: Point {
            x: a.x + (b.x - a.x) * third,
            y: a.y + (b.y - a.y) * third,
        },
        c2: Point {
            x: a.x + (b.x - a.x) * 2.0 * third,
            y: a.y + (b.y - a.y) * 2.0 * third,
        },
        p1: b,
    }
}

/// 端点と接線の向きを固定したまま、制御点の長さを最小二乗で決める
fn generate(pts: &[Point], u: &[f32], t0: (f32, f32), t1: (f32, f32)) -> Cubic {
    let n = pts.len();
    let first = pts[0];
    let last = pts[n - 1];

    let mut c = [[0f32; 2]; 2];
    let mut x = [0f32; 2];

    for i in 0..n {
        let t = u[i];
        let b0 = b0(t);
        let b1 = b1(t);
        let b2 = b2(t);
        let b3 = b3(t);

        let a0 = (t0.0 * b1, t0.1 * b1);
        let a1 = (t1.0 * b2, t1.1 * b2);

        c[0][0] += a0.0 * a0.0 + a0.1 * a0.1;
        c[0][1] += a0.0 * a1.0 + a0.1 * a1.1;
        c[1][0] = c[0][1];
        c[1][1] += a1.0 * a1.0 + a1.1 * a1.1;

        let tmp = (
            pts[i].x - (first.x * (b0 + b1) + last.x * (b2 + b3)),
            pts[i].y - (first.y * (b0 + b1) + last.y * (b2 + b3)),
        );
        x[0] += a0.0 * tmp.0 + a0.1 * tmp.1;
        x[1] += a1.0 * tmp.0 + a1.1 * tmp.1;
    }

    let det_c = c[0][0] * c[1][1] - c[1][0] * c[0][1];
    let det_x0 = x[0] * c[1][1] - x[1] * c[0][1];
    let det_x1 = c[0][0] * x[1] - c[1][0] * x[0];

    let (mut alpha0, mut alpha1) = if det_c.abs() < 1e-12 {
        (0.0, 0.0)
    } else {
        (det_x0 / det_c, det_x1 / det_c)
    };

    // 制御点が裏返るような解は使えないので、素直な三等分に逃がす
    let span = (dist(first, last) / 3.0).max(1e-6);
    if alpha0 < 1e-6 || alpha1 < 1e-6 {
        alpha0 = span;
        alpha1 = span;
    }

    Cubic {
        p0: first,
        c1: Point {
            x: first.x + t0.0 * alpha0,
            y: first.y + t0.1 * alpha0,
        },
        c2: Point {
            x: last.x + t1.0 * alpha1,
            y: last.y + t1.1 * alpha1,
        },
        p1: last,
    }
}

fn chord_length_parameters(pts: &[Point]) -> Vec<f32> {
    let mut u = vec![0f32; pts.len()];
    for i in 1..pts.len() {
        u[i] = u[i - 1] + dist(pts[i - 1], pts[i]);
    }
    let total = u[pts.len() - 1];
    if total > 0.0 {
        for v in &mut u {
            *v /= total;
        }
    }
    u
}

fn max_error(pts: &[Point], curve: &Cubic, u: &[f32]) -> (f32, usize) {
    let mut worst = 0.0f32;
    let mut index = pts.len() / 2;
    for i in 1..pts.len() - 1 {
        let q = evaluate(curve, u[i]);
        let d = dist(q, pts[i]);
        if d > worst {
            worst = d;
            index = i;
        }
    }
    (worst, index)
}

/// ニュートン法で、各点にいちばん近い媒介変数へ寄せる
fn reparameterize(pts: &[Point], curve: &Cubic, u: &mut [f32]) {
    for i in 0..pts.len() {
        u[i] = newton_step(curve, pts[i], u[i]);
    }
}

fn newton_step(curve: &Cubic, p: Point, t: f32) -> f32 {
    let q = evaluate(curve, t);
    let d1 = derivative(curve, t);
    let d2 = second_derivative(curve, t);

    let diff = (q.x - p.x, q.y - p.y);
    let numerator = diff.0 * d1.0 + diff.1 * d1.1;
    let denominator = d1.0 * d1.0 + d1.1 * d1.1 + diff.0 * d2.0 + diff.1 * d2.1;
    if denominator.abs() < 1e-12 {
        t
    } else {
        (t - numerator / denominator).clamp(0.0, 1.0)
    }
}

pub fn evaluate(c: &Cubic, t: f32) -> Point {
    Point {
        x: c.p0.x * b0(t) + c.c1.x * b1(t) + c.c2.x * b2(t) + c.p1.x * b3(t),
        y: c.p0.y * b0(t) + c.c1.y * b1(t) + c.c2.y * b2(t) + c.p1.y * b3(t),
    }
}

fn derivative(c: &Cubic, t: f32) -> (f32, f32) {
    let mt = 1.0 - t;
    let a = 3.0 * mt * mt;
    let b = 6.0 * mt * t;
    let d = 3.0 * t * t;
    (
        a * (c.c1.x - c.p0.x) + b * (c.c2.x - c.c1.x) + d * (c.p1.x - c.c2.x),
        a * (c.c1.y - c.p0.y) + b * (c.c2.y - c.c1.y) + d * (c.p1.y - c.c2.y),
    )
}

fn second_derivative(c: &Cubic, t: f32) -> (f32, f32) {
    let mt = 1.0 - t;
    (
        6.0 * mt * (c.c2.x - 2.0 * c.c1.x + c.p0.x) + 6.0 * t * (c.p1.x - 2.0 * c.c2.x + c.c1.x),
        6.0 * mt * (c.c2.y - 2.0 * c.c1.y + c.p0.y) + 6.0 * t * (c.p1.y - 2.0 * c.c2.y + c.c1.y),
    )
}

fn b0(t: f32) -> f32 {
    let mt = 1.0 - t;
    mt * mt * mt
}
fn b1(t: f32) -> f32 {
    let mt = 1.0 - t;
    3.0 * t * mt * mt
}
fn b2(t: f32) -> f32 {
    let mt = 1.0 - t;
    3.0 * t * t * mt
}
fn b3(t: f32) -> f32 {
    t * t * t
}

fn dedup(points: &[Point]) -> Vec<Point> {
    let mut out: Vec<Point> = Vec::with_capacity(points.len());
    for p in points {
        if out.last().map(|q| dist(*q, *p) > 1e-5).unwrap_or(true) {
            out.push(*p);
        }
    }
    out
}

fn sub(a: Point, b: Point) -> (f32, f32) {
    (a.x - b.x, a.y - b.y)
}

fn normalize(v: (f32, f32)) -> (f32, f32) {
    let len = (v.0 * v.0 + v.1 * v.1).sqrt();
    if len < 1e-9 {
        (0.0, 0.0)
    } else {
        (v.0 / len, v.1 / len)
    }
}

fn dist(a: Point, b: Point) -> f32 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f32, y: f32) -> Point {
        Point { x, y }
    }

    /// 当てはめた曲線が、元の点からどれだけ離れているか。
    ///
    /// 標本が粗いと、曲線のずれではなく**標本の間隔**を測ってしまう。
    /// 許容誤差 0.05 を判定するので、それよりずっと細かく刻む。
    const SAMPLES: usize = 2000;

    fn worst_distance(curves: &[Cubic], points: &[Point]) -> f32 {
        let mut worst = 0.0f32;
        for pt in points {
            let mut best = f32::MAX;
            for c in curves {
                for i in 0..=SAMPLES {
                    let q = evaluate(c, i as f32 / SAMPLES as f32);
                    best = best.min(dist(q, *pt));
                }
            }
            worst = worst.max(best);
        }
        worst
    }

    #[test]
    fn 直線は一本の曲線で足りる() {
        let pts: Vec<Point> = (0..20).map(|i| p(i as f32, 0.0)).collect();
        let curves = fit(&pts, 0.05);
        assert_eq!(curves.len(), 1);
        assert!(worst_distance(&curves, &pts) < 0.05);
    }

    #[test]
    fn 円弧が許容誤差に収まる() {
        let pts: Vec<Point> = (0..=30)
            .map(|i| {
                let t = i as f32 / 30.0 * std::f32::consts::FRAC_PI_2;
                p(t.cos() * 100.0, t.sin() * 100.0)
            })
            .collect();
        let curves = fit(&pts, 0.5);
        let err = worst_distance(&curves, &pts);
        assert!(err < 0.5, "ずれ {err}");
        assert!(curves.len() <= 3, "曲線の数 {}", curves.len());
    }

    #[test]
    fn 波打つ線も許容誤差に収まる() {
        let pts: Vec<Point> = (0..=100)
            .map(|i| {
                let x = i as f32;
                p(x, (x / 8.0).sin() * 20.0)
            })
            .collect();
        let curves = fit(&pts, 0.4);
        let err = worst_distance(&curves, &pts);
        assert!(err < 0.4, "ずれ {err} / 曲線 {} 本", curves.len());
    }

    #[test]
    fn 点の数より曲線はずっと少ない() {
        let pts: Vec<Point> = (0..=200)
            .map(|i| {
                let t = i as f32 / 200.0 * std::f32::consts::TAU;
                p(t.cos() * 80.0, t.sin() * 80.0)
            })
            .collect();
        let curves = fit(&pts, 0.3);
        assert!(
            curves.len() < 12,
            "201 点が {} 本になった。減っていない",
            curves.len()
        );
    }

    #[test]
    fn 同じ点が続いても落ちない() {
        let pts = vec![p(0.0, 0.0), p(0.0, 0.0), p(5.0, 0.0), p(5.0, 0.0)];
        let curves = fit(&pts, 0.1);
        assert!(!curves.is_empty());
    }
}
