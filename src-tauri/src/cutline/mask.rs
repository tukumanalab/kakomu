//! 二値マスクの操作。
//!
//! 切る線を作る前に、絵のかたちを整える。
//! ゴミのような点を消し、必要なら穴を埋め、指定した幅ぶん外に広げる。

use super::edt;

/// 角の削りかすと、本当のくびれを分ける面積（画素）。
/// 実測にもとづく。thicken_thin_parts の表を参照
#[allow(non_snake_case)]
fn CORNER_CRUMB_LIMIT(radius: f32) -> usize {
    (1.5 * radius * radius).ceil() as usize
}

#[derive(Debug, Clone)]
pub struct Mask {
    pub width: usize,
    pub height: usize,
    pub bits: Vec<bool>,
}

impl Mask {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            bits: vec![false; width * height],
        }
    }

    #[inline]
    #[allow(dead_code)]
    pub fn get(&self, x: usize, y: usize) -> bool {
        self.bits[y * self.width + x]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, on: bool) {
        self.bits[y * self.width + x] = on;
    }

    pub fn count(&self) -> usize {
        self.bits.iter().filter(|b| **b).count()
    }

    /// 前景までの距離（ピクセル）
    pub fn distance_field(&self) -> Vec<f32> {
        edt::distance(&self.bits, self.width, self.height)
    }

    /// 外側に radius だけ広げる。角は自然に丸くなる
    pub fn dilate(&self, radius: f32) -> Mask {
        if radius <= 0.0 {
            return self.clone();
        }
        let d = self.distance_field();
        Mask {
            width: self.width,
            height: self.height,
            bits: d.iter().map(|v| *v <= radius).collect(),
        }
    }

    /// 内側に radius だけ縮める。背景からの距離が radius を超える所だけ残す
    pub fn erode(&self, radius: f32) -> Mask {
        if radius <= 0.0 {
            return self.clone();
        }
        let inverted: Vec<bool> = self.bits.iter().map(|b| !*b).collect();
        let d = edt::distance(&inverted, self.width, self.height);
        Mask {
            width: self.width,
            height: self.height,
            bits: d.iter().map(|v| *v > radius).collect(),
        }
    }

    pub fn union(&self, other: &Mask) -> Mask {
        Mask {
            width: self.width,
            height: self.height,
            bits: self
                .bits
                .iter()
                .zip(&other.bits)
                .map(|(a, b)| *a || *b)
                .collect(),
        }
    }

    pub fn difference(&self, other: &Mask) -> Mask {
        Mask {
            width: self.width,
            height: self.height,
            bits: self
                .bits
                .iter()
                .zip(&other.bits)
                .map(|(a, b)| *a && !*b)
                .collect(),
        }
    }

    /// 面積が min_px 未満のかたまりを消す。
    /// スキャンのゴミや、消し残った小さな点を落とすため
    pub fn remove_small_islands(&self, min_px: usize) -> Mask {
        let labels = self.label_components();
        let mut sizes = vec![0usize; labels.1 + 1];
        for &l in &labels.0 {
            if l > 0 {
                sizes[l] += 1;
            }
        }
        Mask {
            width: self.width,
            height: self.height,
            bits: labels
                .0
                .iter()
                .map(|&l| l > 0 && sizes[l] >= min_px)
                .collect(),
        }
    }

    /// 内側の穴を埋める。
    /// 外周から届かない背景＝閉じた穴、という判定でよい
    pub fn fill_holes(&self) -> Mask {
        let w = self.width;
        let h = self.height;
        let mut reachable = vec![false; w * h];
        let mut stack: Vec<usize> = Vec::new();

        let push = |i: usize, stack: &mut Vec<usize>, reachable: &mut Vec<bool>| {
            if !self.bits[i] && !reachable[i] {
                reachable[i] = true;
                stack.push(i);
            }
        };
        for x in 0..w {
            push(x, &mut stack, &mut reachable);
            push((h - 1) * w + x, &mut stack, &mut reachable);
        }
        for y in 0..h {
            push(y * w, &mut stack, &mut reachable);
            push(y * w + w - 1, &mut stack, &mut reachable);
        }

        while let Some(i) = stack.pop() {
            let x = i % w;
            let y = i / w;
            let mut visit = |nx: usize, ny: usize, stack: &mut Vec<usize>| {
                let j = ny * w + nx;
                if !self.bits[j] && !reachable[j] {
                    reachable[j] = true;
                    stack.push(j);
                }
            };
            if x > 0 {
                visit(x - 1, y, &mut stack);
            }
            if x + 1 < w {
                visit(x + 1, y, &mut stack);
            }
            if y > 0 {
                visit(x, y - 1, &mut stack);
            }
            if y + 1 < h {
                visit(x, y + 1, &mut stack);
            }
        }

        Mask {
            width: w,
            height: h,
            bits: (0..w * h).map(|i| self.bits[i] || !reachable[i]).collect(),
        }
    }

    /// 4 近傍の連結成分に番号を振る。戻り値は (番号の配列, 個数)
    fn label_components(&self) -> (Vec<usize>, usize) {
        let w = self.width;
        let h = self.height;
        let mut labels = vec![0usize; w * h];
        let mut next = 0usize;
        let mut stack: Vec<usize> = Vec::new();

        for start in 0..w * h {
            if !self.bits[start] || labels[start] != 0 {
                continue;
            }
            next += 1;
            labels[start] = next;
            stack.push(start);
            while let Some(i) = stack.pop() {
                let x = i % w;
                let y = i / w;
                let visit = |nx: usize, ny: usize, labels: &mut Vec<usize>, st: &mut Vec<usize>| {
                    let j = ny * w + nx;
                    if self.bits[j] && labels[j] == 0 {
                        labels[j] = next;
                        st.push(j);
                    }
                };
                if x > 0 {
                    visit(x - 1, y, &mut labels, &mut stack);
                }
                if x + 1 < w {
                    visit(x + 1, y, &mut labels, &mut stack);
                }
                if y > 0 {
                    visit(x, y - 1, &mut labels, &mut stack);
                }
                if y + 1 < h {
                    visit(x, y + 1, &mut labels, &mut stack);
                }
            }
        }
        (labels, next)
    }

    /// 細すぎるところを太らせる。
    ///
    /// 開き（縮めてから広げる）で細い部分だけを取り出し、それを広げて元に足す。
    ///   thin   = 元 − 開いた形     … 半径 r の円が通れない部分
    ///   結果   = 元 ∪ 広げた thin  … その部分だけ 2r 相当まで太らせる
    ///
    /// 開いた形をそのまま採用すると、細い尻尾やリボンが**切り落とされて**
    /// 絵が線からはみ出してしまう。太らせる側に倒すのが正しい。
    ///
    /// なお、開きは**とがった角の先端も削る**。角は折れやすい細さとは別の話
    /// （それは鋭角として別に知らせる）なので、面積で振り分けて捨てる。
    /// しきい値は実測で決めた（下の probe テストを参照）:
    ///
    /// | 半径 r | 角の削りかす | 本当のくびれ |
    /// |---|---|---|
    /// | 3  | 5  | 84  |
    /// | 6  | 14 | 194 |
    /// | 12 | 46 | 344 |
    ///
    /// 角は r² の 0.3〜0.6 倍、くびれは 2.4〜9 倍。1.5 倍で分かれる。
    pub fn thicken_thin_parts(&self, radius: f32) -> Mask {
        if radius <= 0.0 {
            return self.clone();
        }
        let opened = self.erode(radius).dilate(radius);
        let thin = self
            .difference(&opened)
            .remove_small_islands(CORNER_CRUMB_LIMIT(radius));
        if thin.count() == 0 {
            return self.clone();
        }
        self.union(&thin.dilate(radius))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(w: usize, h: usize, x0: usize, y0: usize, x1: usize, y1: usize) -> Mask {
        let mut m = Mask::new(w, h);
        for y in y0..y1 {
            for x in x0..x1 {
                m.set(x, y, true);
            }
        }
        m
    }

    #[test]
    fn 広げると面積が増える() {
        let m = rect(21, 21, 9, 9, 12, 12);
        let d = m.dilate(3.0);
        assert!(d.count() > m.count());
        // 元の中身は残る
        assert!(d.get(10, 10));
        // 3 ピクセル外は入る、5 ピクセル外は入らない
        assert!(d.get(9 - 3, 10));
        assert!(!d.get(9 - 5, 10));
    }

    #[test]
    fn 縮めると内側だけ残る() {
        let m = rect(21, 21, 5, 5, 16, 16);
        let e = m.erode(2.0);
        assert!(e.get(10, 10), "真ん中は残る");
        assert!(!e.get(5, 5), "角は消える");
        assert!(e.count() < m.count());
    }

    #[test]
    fn 小さすぎるかたまりは消える() {
        let mut m = rect(21, 21, 2, 2, 10, 10); // 64 画素
        m.set(18, 18, true); // 1 画素のゴミ
        let cleaned = m.remove_small_islands(10);
        assert!(cleaned.get(5, 5), "大きいほうは残る");
        assert!(!cleaned.get(18, 18), "ゴミは消える");
    }

    #[test]
    fn 内側の穴が埋まる() {
        let mut m = rect(21, 21, 4, 4, 17, 17);
        m.set(10, 10, false);
        m.set(10, 11, false);
        assert!(!m.get(10, 10));
        let filled = m.fill_holes();
        assert!(filled.get(10, 10), "穴が埋まる");
        assert!(!filled.get(0, 0), "外の背景は埋まらない");
    }

    #[test]
    fn 細いくびれが太くなる() {
        // 上下の大きな四角を、細い首でつないだ形。
        // 実際の作業解像度（1mm ≒ 16 画素）に近い比率にしてある
        let mut m = Mask::new(100, 140);
        for y in 20..55 {
            for x in 25..75 {
                m.set(x, y, true);
            }
        }
        for y in 85..120 {
            for x in 25..75 {
                m.set(x, y, true);
            }
        }
        for y in 55..85 {
            for x in 47..=53 {
                m.set(x, y, true); // 幅 7 画素の首
            }
        }

        let before = width_at_row(&m, 70);
        let fixed = m.thicken_thin_parts(6.0);
        let after = width_at_row(&fixed, 70);

        assert_eq!(before, 7, "元の首は 7 画素");
        assert!(after >= 12, "首が太くなるはず: {after} 画素");
        assert!(fixed.get(30, 30) && fixed.get(30, 110), "大きい部分は残る");
    }

    /// とがった角は開きで削られるが、それは折れやすい細さではない。
    /// 角まで太らせると形が膨らんでしまうので、変えないのが正しい
    #[test]
    fn 四角の角は太らせない() {
        let m = rect(100, 100, 30, 30, 70, 70);
        for r in [3.0f32, 6.0, 12.0] {
            let fixed = m.thicken_thin_parts(r);
            assert_eq!(m.count(), fixed.count(), "半径 {r} で形が変わった");
        }
    }

    fn width_at_row(m: &Mask, y: usize) -> usize {
        (0..m.width).filter(|&x| m.get(x, y)).count()
    }
}

#[cfg(test)]
mod probe {
    use super::*;

    /// しきい値を決めるために、角の削りかすと本当のくびれの大きさを測る
    #[test]
    #[ignore = "しきい値の実測用"]
    fn 細い部分の大きさを測る() {
        for r in [3.0f32, 6.0, 12.0] {
            // 四角の角
            let mut sq = Mask::new(100, 100);
            for y in 30..70 {
                for x in 30..70 {
                    sq.set(x, y, true);
                }
            }
            let thin_sq = sq.difference(&sq.erode(r).dilate(r));
            let sizes_sq = component_sizes(&thin_sq);

            // 2 つの塊を細い首でつないだ形
            let mut nk = Mask::new(100, 140);
            for y in 20..55 {
                for x in 25..75 {
                    nk.set(x, y, true);
                }
            }
            for y in 85..120 {
                for x in 25..75 {
                    nk.set(x, y, true);
                }
            }
            let half = (r as usize).max(1) / 2;
            for y in 55..85 {
                for x in (50 - half)..=(50 + half) {
                    nk.set(x, y, true);
                }
            }
            let thin_nk = nk.difference(&nk.erode(r).dilate(r));
            let sizes_nk = component_sizes(&thin_nk);

            println!(
                "r={r}  r^2={:.0}  角の削りかす={:?}  くびれ={:?}",
                r * r,
                sizes_sq,
                sizes_nk
            );
        }
    }

    fn component_sizes(m: &Mask) -> Vec<usize> {
        let (labels, n) = m.label_components();
        let mut sizes = vec![0usize; n + 1];
        for &l in &labels {
            if l > 0 {
                sizes[l] += 1;
            }
        }
        let mut out: Vec<usize> = sizes.into_iter().skip(1).collect();
        out.sort_unstable_by(|a, b| b.cmp(a));
        out.truncate(6);
        out
    }
}
