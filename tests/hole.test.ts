/**
 * キーホルダーの穴の検査。
 *
 * ここがずれると、穴がふちに寄りすぎた板が切れてくる。折れた板は
 * 戻ってこないので、SPEC 7.6 の寸法をそのままテストにしておく。
 */
import { describe, expect, it } from 'vitest';
import {
  circleSubPath,
  clearance,
  flattenSubpaths,
  placeHole,
  placeHoleNear,
} from '../src/geometry/hole';
import { subpathsToPathData } from '../src/geometry/path';
import { IDENTITY } from '../src/document/types';
import type { Matrix, Point, SubPath } from '../src/document/types';

/** 角の直線だけでできた長方形。ハンドルは 0 */
function rect(x: number, y: number, w: number, h: number): SubPath {
  const corner = (px: number, py: number) => ({
    p: { x: px, y: py },
    in: { x: 0, y: 0 },
    out: { x: 0, y: 0 },
    kind: 'corner' as const,
  });
  return {
    closed: true,
    anchors: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)],
  };
}

function polysOf(subpaths: SubPath[], transform: Matrix = IDENTITY): Point[][] {
  return flattenSubpaths(subpaths, transform);
}

describe('ふちまでの距離', () => {
  const polys = polysOf([rect(0, 0, 40, 60)]);

  it('内側は正、外側は負', () => {
    expect(clearance({ x: 20, y: 30 }, polys)).toBeGreaterThan(0);
    expect(clearance({ x: -5, y: 30 }, polys)).toBeLessThan(0);
  });

  it('いちばん近いふちまでの距離になる', () => {
    // 左のふちから 3mm のところ
    expect(clearance({ x: 3, y: 30 }, polys)).toBeCloseTo(3, 3);
  });

  it('内輪郭（抜き）の中は外側とみなす', () => {
    // 中央に 10mm 角の抜きがある板。抜きの中に穴をあけたら落ちてしまう
    const withHole = polysOf([rect(0, 0, 40, 60), rect(15, 25, 10, 10)]);
    expect(clearance({ x: 20, y: 30 }, withHole)).toBeLessThan(0);
  });

  it('transform がかかっていても世界座標で測る', () => {
    const moved = polysOf([rect(0, 0, 40, 60)], [1, 0, 0, 1, 100, 0]);
    expect(clearance({ x: 103, y: 30 }, moved)).toBeCloseTo(3, 3);
    expect(clearance({ x: 3, y: 30 }, moved)).toBeLessThan(0);
  });
});

describe('穴を置く場所', () => {
  const spec = { diameterMm: 4, marginMm: 3 };

  it('切る線の内側に、ふちから離して置く', () => {
    const polys = polysOf([rect(0, 0, 40, 60)]);
    const placed = placeHole(polys, spec);
    if (!placed.ok) throw new Error('置けるはずの形で置けなかった');

    // 穴のふちからふちまでが 3mm 以上あること
    expect(placed.marginMm).toBeGreaterThanOrEqual(spec.marginMm - 1e-6);
    // 中心からなら 2 + 3 = 5mm 以上
    expect(clearance(placed.center, polys)).toBeGreaterThanOrEqual(5 - 1e-6);
  });

  it('上から吊るすので、置けるうちのいちばん上を選ぶ', () => {
    const polys = polysOf([rect(0, 0, 40, 60)]);
    const placed = placeHole(polys, spec);
    if (!placed.ok) throw new Error('置けるはずの形で置けなかった');

    // 上のふちから 5mm。細かく詰めるので 0.1mm まで寄る
    expect(placed.center.y).toBeLessThan(5.1);
    // 横は真ん中あたり
    expect(placed.center.x).toBeCloseTo(20, 0);
  });

  it('狭すぎる板には置かない', () => {
    // 幅 8mm。φ4 の穴に 3mm ずつ足すと 10mm 要る
    const placed = placeHole(polysOf([rect(0, 0, 8, 60)]), spec);
    expect(placed.ok).toBe(false);
    if (placed.ok) return;
    // どれだけ足りないかが分かる値を返す
    expect(placed.bestMarginMm).toBeLessThan(spec.marginMm);
  });

  it('穴を小さくすれば、同じ板でも置けるようになる', () => {
    const polys = polysOf([rect(0, 0, 8, 60)]);
    expect(placeHole(polys, { diameterMm: 2, marginMm: 2 }).ok).toBe(true);
  });

  it('抜きのある板では、抜きを避けて置く', () => {
    // 上のほうに大きな抜きがある。素直に上を選ぶと抜きにぶつかる
    const polys = polysOf([rect(0, 0, 40, 60), rect(5, 0, 30, 20)]);
    const placed = placeHole(polys, spec);
    if (!placed.ok) throw new Error('置けるはずの形で置けなかった');
    expect(clearance(placed.center, polys)).toBeGreaterThanOrEqual(5 - 1e-6);
  });
});

describe('穴のかたち', () => {
  it('原点を中心にした 4 本のベジェになる', () => {
    const sub = circleSubPath(2);
    expect(sub.closed).toBe(true);
    expect(sub.anchors).toHaveLength(4);
    for (const a of sub.anchors) {
      expect(Math.hypot(a.p.x, a.p.y)).toBeCloseTo(2, 6);
    }
    // 円弧（A コマンド）を使わない。加工機のソフトが解釈できないことがある
    const d = subpathsToPathData([sub]);
    expect(d).not.toMatch(/[Aa]\s/);
    expect(d.match(/C /g)).toHaveLength(4);
  });

  it('折れ線にすると、ほぼ真円になる', () => {
    const polys = flattenSubpaths([circleSubPath(2)], IDENTITY);
    const pts = polys[0]!;
    for (const p of pts) {
      // ベジェ 4 本の円は、半径が最大 0.02% ずれる
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(2, 2);
    }
  });

  it('直径を変えると、その半径の円になる', () => {
    const sub = circleSubPath(1);
    expect(Math.hypot(sub.anchors[0]!.p.x, sub.anchors[0]!.p.y)).toBeCloseTo(1, 6);
  });
});

describe('押した場所に置く（穴の道具）', () => {
  const spec = { diameterMm: 4, marginMm: 3 };
  const polys = flattenSubpaths([rect(0, 0, 40, 60)], IDENTITY);

  it('条件を満たす場所を押したら、そこにそのまま置く', () => {
    const placed = placeHoleNear(polys, spec, { x: 20, y: 30 });
    if (!placed.ok) throw new Error('置けるはず');
    expect(placed.center).toEqual({ x: 20, y: 30 });
  });

  it('ふちに寄りすぎた場所を押したら、いちばん近い置ける場所に寄せる', () => {
    // 左のふちから 1mm。中心から 5mm は要るので、x=5 まで押し戻される
    const placed = placeHoleNear(polys, spec, { x: 1, y: 30 });
    if (!placed.ok) throw new Error('置けるはず');
    expect(placed.center.x).toBeCloseTo(5, 1);
    expect(placed.center.y).toBeCloseTo(30, 1);
    expect(placed.marginMm).toBeGreaterThanOrEqual(spec.marginMm - 1e-6);
  });

  it('切る線の外を押しても、内側に吸い付く', () => {
    const placed = placeHoleNear(polys, spec, { x: -20, y: 10 });
    if (!placed.ok) throw new Error('置けるはず');
    expect(clearance(placed.center, polys)).toBeGreaterThanOrEqual(5 - 1e-6);
    // 押した場所に近い側（左上）に来る
    expect(placed.center.x).toBeLessThan(10);
    expect(placed.center.y).toBeLessThan(15);
  });

  it('どこにも置けない形なら断る', () => {
    const narrow = flattenSubpaths([rect(0, 0, 8, 60)], IDENTITY);
    expect(placeHoleNear(narrow, spec, { x: 4, y: 30 }).ok).toBe(false);
  });
});
