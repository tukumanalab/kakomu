/**
 * mm 座標系の affine 変換。
 *
 * 行列は SVG と同じ [a, b, c, d, e, f] の並び:
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 *
 * このアプリでは常に「平行移動 × 回転」の形でのみ合成する。
 * 拡縮はノードの widthMm / heightMm 側で持つ（実寸を数値で編集できるようにするため）。
 * この不変条件があるので decompose は厳密に元の値を返す。
 */

import type { Matrix, Point } from '~/document/types';
import { IDENTITY } from '~/document/types';

export { IDENTITY };
export type { Matrix, Point };

export function multiply(m: Matrix, n: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** 平行移動（mm）と回転（度）から作る */
export function compose(tx: number, ty: number, rotationDeg: number): Matrix {
  const r = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, tx, ty];
}

export interface Decomposed {
  /** mm */
  x: number;
  y: number;
  /** 度。-180 〜 180 */
  rotationDeg: number;
}

export function decompose(m: Matrix): Decomposed {
  const [a, b, , , e, f] = m;
  return {
    x: e,
    y: f,
    rotationDeg: (Math.atan2(b, a) * 180) / Math.PI,
  };
}

export function apply(m: Matrix, p: Point): Point {
  const [a, b, c, d, e, f] = m;
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) return IDENTITY;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

/** SVG の transform 属性に書ける文字列。座標は mm のまま */
export function toSvg(m: Matrix): string {
  return `matrix(${m.map((v) => round(v)).join(' ')})`;
}

function round(v: number): number {
  return Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e6) / 1e6;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 変換後の 4 隅を包む軸並行の外接矩形（mm） */
export function transformedBounds(m: Matrix, width: number, height: number): Rect {
  const corners: Point[] = [
    apply(m, { x: 0, y: 0 }),
    apply(m, { x: width, y: 0 }),
    apply(m, { x: width, y: height }),
    apply(m, { x: 0, y: height }),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** 変換後の 4 隅（回転を保った選択枠の描画に使う） */
export function corners(m: Matrix, width: number, height: number): Point[] {
  return [
    apply(m, { x: 0, y: 0 }),
    apply(m, { x: width, y: 0 }),
    apply(m, { x: width, y: height }),
    apply(m, { x: 0, y: height }),
  ];
}
