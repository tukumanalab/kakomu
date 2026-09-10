/**
 * 切るデータ（SVG）の組み立て。
 *
 * 出力先は xTool P3（制御ソフトは XCS）。SPEC 8.1 の決め事:
 *   - 1 ユーザー単位 = 1mm。どのソフトで開いても実寸が保たれる
 *   - XCS は色で加工を振り分ける。レイヤー名より色のほうが確実に効く
 *   - 塗りのある図形は「彫刻」扱いになるので fill="none" を必ず付ける
 *   - transform はすべてベイクして絶対座標にする。加工機のソフトが
 *     解釈できないことがある
 *   - 円弧を使わず三次ベジェだけで書く。互換性がいちばん高い
 */

import type { Anchor, Doc, Node, PathNode, Point, SubPath } from '~/document/types';
import { KAPPA } from '~/geometry/path';
import * as M from '~/geometry/matrix';

export interface CutlineSvgOptions {
  /** 線の色。XCS 側の割り当てに合わせて変えられる */
  color: string;
  /** 線幅（mm）。ヘアライン */
  strokeWidthMm: number;
  /** レイヤー名 */
  layerName: string;
}

export const DEFAULT_SVG_OPTIONS: CutlineSvgOptions = {
  color: '#FF00FF',
  strokeWidthMm: 0.1,
  layerName: 'CutContour',
};

export interface CutlineSvg {
  svg: string;
  /** 切る線がまだ無いので、板の外形で代用したか */
  usedBoardOutline: boolean;
}

export function buildCutlineSvg(
  doc: Doc,
  options: CutlineSvgOptions = DEFAULT_SVG_OPTIONS,
): CutlineSvg {
  const paths: string[] = [];

  for (const layer of doc.layers) {
    if (layer.role !== 'cutline' && layer.role !== 'parts') continue;
    if (!layer.visible) continue;
    for (const node of layer.nodes) {
      const d = nodeToPathData(node);
      if (d) paths.push(d);
    }
  }

  // 切る線をまだ作っていない段階でも、実寸と色が加工機に正しく伝わるかを
  // 確かめられるように、板の外形を仮に出す（M4 で本物に置き換わる）
  const usedBoardOutline = paths.length === 0;
  if (usedBoardOutline) {
    paths.push(boardOutline(doc.canvas.widthMm, doc.canvas.heightMm, 3));
  }

  const { widthMm, heightMm } = doc.canvas;
  const body = paths
    .map(
      (d) =>
        `    <path d="${d}" fill="none" stroke="${options.color}" ` +
        `stroke-width="${options.strokeWidthMm}"/>`,
    )
    .join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- kakomu が書き出した切るデータ。1 ユーザー単位 = 1mm -->
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     width="${widthMm}mm" height="${heightMm}mm"
     viewBox="0 0 ${widthMm} ${heightMm}">
  <g id="cutline" inkscape:groupmode="layer" inkscape:label="${options.layerName}">
${body}
  </g>
</svg>
`;

  return { svg, usedBoardOutline };
}

/** 板の外形（角丸の長方形）。三次ベジェだけで書く */
function boardOutline(w: number, h: number, r: number): string {
  const c = r * KAPPA;
  return [
    `M ${n(r)} 0`,
    `L ${n(w - r)} 0`,
    `C ${n(w - r + c)} 0 ${n(w)} ${n(r - c)} ${n(w)} ${n(r)}`,
    `L ${n(w)} ${n(h - r)}`,
    `C ${n(w)} ${n(h - r + c)} ${n(w - r + c)} ${n(h)} ${n(w - r)} ${n(h)}`,
    `L ${n(r)} ${n(h)}`,
    `C ${n(r - c)} ${n(h)} 0 ${n(h - r + c)} 0 ${n(h - r)}`,
    `L 0 ${n(r)}`,
    `C 0 ${n(r - c)} ${n(r - c)} 0 ${n(r)} 0`,
    'Z',
  ].join(' ');
}

function nodeToPathData(node: Node): string | null {
  if (node.type !== 'path' || !node.visible) return null;
  const path = node as PathNode;
  const parts = path.subpaths.map((sp) => subPathToData(sp, path.transform));
  return parts.filter(Boolean).join(' ') || null;
}

/** transform をベイクして絶対座標の三次ベジェ列にする */
function subPathToData(sub: SubPath, transform: M.Matrix): string {
  const anchors = sub.anchors;
  if (anchors.length === 0) return '';

  const world = (p: Point) => M.apply(transform, p);
  /** ハンドルはアンカーからの相対なので、足してから変換する */
  const handle = (a: Anchor, which: 'in' | 'out') =>
    world({ x: a.p.x + a[which].x, y: a.p.y + a[which].y });

  const first = world(anchors[0]!.p);
  const out: string[] = [`M ${n(first.x)} ${n(first.y)}`];

  const last = sub.closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < last; i++) {
    const a = anchors[i]!;
    const b = anchors[(i + 1) % anchors.length]!;
    const c1 = handle(a, 'out');
    const c2 = handle(b, 'in');
    const p = world(b.p);
    out.push(`C ${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(p.x)} ${n(p.y)}`);
  }
  if (sub.closed) out.push('Z');
  return out.join(' ');
}

/** 0.001mm まで。加工機の精度に対して十分で、桁が無駄に増えない */
function n(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}
