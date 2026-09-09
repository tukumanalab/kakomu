import { describe, expect, it } from 'vitest';
import { apply, compose, corners, decompose, invert } from '../src/geometry/matrix';

describe('matrix', () => {
  it('compose した値を decompose で取り戻せる', () => {
    const m = compose(12.5, -3.25, 37);
    const d = decompose(m);
    expect(d.x).toBeCloseTo(12.5, 9);
    expect(d.y).toBeCloseTo(-3.25, 9);
    expect(d.rotationDeg).toBeCloseTo(37, 9);
  });

  it('逆行列を適用すると元の点に戻る', () => {
    const m = compose(40, 15, 22);
    const p = { x: 7, y: -2 };
    const back = apply(invert(m), apply(m, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('回転していない矩形の四隅は素直に並ぶ', () => {
    const c = corners(compose(10, 20, 0), 30, 40);
    expect(c[0]).toEqual({ x: 10, y: 20 });
    expect(c[2]!.x).toBeCloseTo(40, 9);
    expect(c[2]!.y).toBeCloseTo(60, 9);
  });
});
