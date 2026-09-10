/**
 * パスの d 属性づくり。
 * 円弧を使わず三次ベジェだけで書く（加工機の互換性がいちばん高い）。
 */

import type { Anchor, SubPath } from '~/document/types';

/**
 * 円を三次ベジェ 4 本で近似するときの、ハンドルの長さの比。
 * 円弧（A コマンド）を使わないのは、加工機のソフトが解釈できないことが
 * あるため。円・角丸はどこでもこの定数で書く。
 */
export const KAPPA = 0.5522847498307936;

/** ノードのローカル座標のまま d を作る。描画側は transform 属性で置く */
export function subpathsToPathData(subpaths: SubPath[]): string {
  return subpaths.map(subPathToData).filter(Boolean).join(' ');
}

function subPathToData(sub: SubPath): string {
  const a = sub.anchors;
  if (a.length === 0) return '';

  const out: string[] = [`M ${n(a[0]!.p.x)} ${n(a[0]!.p.y)}`];
  const last = sub.closed ? a.length : a.length - 1;
  for (let i = 0; i < last; i++) {
    const from = a[i]!;
    const to = a[(i + 1) % a.length]!;
    out.push(
      `C ${n(from.p.x + from.out.x)} ${n(from.p.y + from.out.y)}` +
        ` ${n(to.p.x + to.in.x)} ${n(to.p.y + to.in.y)}` +
        ` ${n(to.p.x)} ${n(to.p.y)}`,
    );
  }
  if (sub.closed) out.push('Z');
  return out.join(' ');
}

/** 点の総数。曲線がどれだけ減ったかを画面に出すのに使う */
export function anchorCount(subpaths: SubPath[]): number {
  return subpaths.reduce((sum, sp) => sum + sp.anchors.length, 0);
}

export function allAnchors(subpaths: SubPath[]): Anchor[] {
  return subpaths.flatMap((sp) => sp.anchors);
}

function n(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}
