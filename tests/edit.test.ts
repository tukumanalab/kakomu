/**
 * 点の編集の検査。
 *
 * ハンドルの連動を間違えると、なめらかだった曲線が折れて、
 * そこがそのまま切る線の角になる。
 */
import { describe, expect, it } from 'vitest';
import { MIN_ANCHORS, deleteAnchor, moveAnchor, moveHandle } from '../src/geometry/edit';
import type { Anchor, AnchorKind, SubPath } from '../src/document/types';

function anchor(x: number, y: number, kind: AnchorKind, inH = { x: -2, y: 0 }, outH = { x: 4, y: 0 }): Anchor {
  return { p: { x, y }, in: inH, out: outH, kind };
}

/** 4 点の閉じた形。0 番が smooth、1 番が corner、2 番が symmetric */
function square(): SubPath[] {
  return [
    {
      closed: true,
      anchors: [
        anchor(0, 0, 'smooth'),
        anchor(10, 0, 'corner'),
        anchor(10, 10, 'symmetric'),
        anchor(0, 10, 'smooth'),
      ],
    },
  ];
}

describe('点を動かす', () => {
  it('点だけがずれ、ハンドルは相対のままついてくる', () => {
    const next = moveAnchor(square(), { sub: 0, index: 1 }, { x: 3, y: -2 });
    const a = next[0]!.anchors[1]!;
    expect(a.p).toEqual({ x: 13, y: -2 });
    expect(a.in).toEqual({ x: -2, y: 0 });
    expect(a.out).toEqual({ x: 4, y: 0 });
  });

  it('他の点は触らない', () => {
    const before = square();
    const next = moveAnchor(before, { sub: 0, index: 1 }, { x: 3, y: -2 });
    expect(next[0]!.anchors[0]).toEqual(before[0]!.anchors[0]);
    expect(next[0]!.anchors[2]).toEqual(before[0]!.anchors[2]);
  });

  it('元の配列を書き換えない', () => {
    const before = square();
    moveAnchor(before, { sub: 0, index: 1 }, { x: 3, y: -2 });
    expect(before[0]!.anchors[1]!.p).toEqual({ x: 10, y: 0 });
  });
});

describe('ハンドルを動かす', () => {
  it('corner は反対側と連動しない', () => {
    const next = moveHandle(square(), { sub: 0, index: 1 }, 'out', { x: 0, y: 5 });
    const a = next[0]!.anchors[1]!;
    expect(a.out).toEqual({ x: 0, y: 5 });
    expect(a.in).toEqual({ x: -2, y: 0 });
  });

  it('smooth は反対側の向きを揃え、長さは元のまま', () => {
    // in は長さ 2 のまま、out を真下 (0,5) に向ける → in は真上を向いて長さ 2
    const next = moveHandle(square(), { sub: 0, index: 0 }, 'out', { x: 0, y: 5 });
    const a = next[0]!.anchors[0]!;
    expect(a.out).toEqual({ x: 0, y: 5 });
    expect(a.in.x).toBeCloseTo(0, 9);
    expect(a.in.y).toBeCloseTo(-2, 9);
  });

  it('symmetric は反対側が鏡写しになる', () => {
    const next = moveHandle(square(), { sub: 0, index: 2 }, 'in', { x: 3, y: 4 });
    const a = next[0]!.anchors[2]!;
    expect(a.in).toEqual({ x: 3, y: 4 });
    expect(a.out.x).toBeCloseTo(-3, 9);
    expect(a.out.y).toBeCloseTo(-4, 9);
  });

  it('ハンドルを点に重ねたとき（長さ 0）は、反対側を触らない', () => {
    const next = moveHandle(square(), { sub: 0, index: 0 }, 'out', { x: 0, y: 0 });
    const a = next[0]!.anchors[0]!;
    expect(a.out).toEqual({ x: 0, y: 0 });
    expect(a.in).toEqual({ x: -2, y: 0 });
  });
});

describe('点を消す', () => {
  it('その点だけが消える', () => {
    const next = deleteAnchor(square(), { sub: 0, index: 1 });
    expect(next).not.toBeNull();
    expect(next![0]!.anchors.map((a) => a.p)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  it(`${MIN_ANCHORS} 点を下回る削除は断る`, () => {
    const three = deleteAnchor(square(), { sub: 0, index: 0 })!;
    expect(three[0]!.anchors).toHaveLength(3);
    expect(deleteAnchor(three, { sub: 0, index: 0 })).toBeNull();
  });

  it('無いサブパスを指しても落ちない', () => {
    expect(deleteAnchor(square(), { sub: 5, index: 0 })).toBeNull();
  });
});
