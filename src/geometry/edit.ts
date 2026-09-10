/**
 * 点の編集。
 *
 * 切る線は普通のパスなので、点をつまんで直せる（SPEC 7.4）。
 * ここは純粋関数だけで、ポインタの扱いはキャンバス側が受け持つ。
 * 座標はノードのローカル mm。
 */

import type { Point, SubPath } from '~/document/types';

/** どのサブパスの何番目の点か */
export interface AnchorRef {
  sub: number;
  index: number;
}

/** 閉じた形として成り立つ最少の点数。これを下回る削除は断る */
export const MIN_ANCHORS = 3;

/** 点をずらす。ハンドルは点からの相対なので、そのままついてくる */
export function moveAnchor(subpaths: SubPath[], ref: AnchorRef, delta: Point): SubPath[] {
  return updateAnchor(subpaths, ref, (a) => ({
    ...a,
    p: { x: a.p.x + delta.x, y: a.p.y + delta.y },
  }));
}

/**
 * ハンドルを置き直す。handle は点からの相対。
 *
 * 反対側のハンドルは点の種類で決まる:
 *   corner    … 独立。つままれた側だけ動く
 *   smooth    … 向きは正反対に揃え、長さは元のまま（曲線が折れない）
 *   symmetric … 向きも長さも鏡写し
 */
export function moveHandle(
  subpaths: SubPath[],
  ref: AnchorRef,
  which: 'in' | 'out',
  handle: Point,
): SubPath[] {
  const other = which === 'in' ? 'out' : 'in';
  return updateAnchor(subpaths, ref, (a) => {
    const next = { ...a, [which]: handle };
    if (a.kind === 'corner') return next;

    const len = Math.hypot(handle.x, handle.y);
    if (len === 0) return next; // 向きが決まらないので反対側は触らない

    const otherLen = a.kind === 'symmetric' ? len : Math.hypot(a[other].x, a[other].y);
    return {
      ...next,
      [other]: { x: (-handle.x / len) * otherLen, y: (-handle.y / len) * otherLen },
    };
  });
}

/** 点を消す。形として成り立たなくなるなら null */
export function deleteAnchor(subpaths: SubPath[], ref: AnchorRef): SubPath[] | null {
  const sp = subpaths[ref.sub];
  if (!sp || sp.anchors.length <= MIN_ANCHORS) return null;
  return subpaths.map((s, i) =>
    i === ref.sub ? { ...s, anchors: s.anchors.filter((_, j) => j !== ref.index) } : s,
  );
}

function updateAnchor(
  subpaths: SubPath[],
  ref: AnchorRef,
  update: (a: SubPath['anchors'][number]) => SubPath['anchors'][number],
): SubPath[] {
  return subpaths.map((s, i) =>
    i === ref.sub
      ? { ...s, anchors: s.anchors.map((a, j) => (j === ref.index ? update(a) : a)) }
      : s,
  );
}
