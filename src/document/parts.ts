/**
 * 部品（いまはキーホルダーの穴だけ）の組み立て。
 *
 * 置く場所を決めるのはジオメトリ側（geometry/hole.ts）の仕事で、
 * ここはそれをドキュメントのノードに変換するところを受け持つ。
 */

import { circleSubPath, clearance, cutlinePolygons, placeHole, placeHoleNear } from '~/geometry/hole';
import * as M from '~/geometry/matrix';
import { uid } from './store';
import type { Doc, HolePart, Matrix, PathNode, Point, SubPath } from './types';
import { DEFAULT_HOLE_PART } from './types';

export interface FoundHole {
  node: PathNode;
  part: HolePart;
}

/** 部品のレイヤーにある穴。いまは 1 つだけ持てる */
export function findHole(d: Doc): FoundHole | null {
  for (const layer of d.layers) {
    if (layer.role !== 'parts') continue;
    for (const node of layer.nodes) {
      if (node.type !== 'path') continue;
      const origin = node.origin;
      if (origin?.type === 'part' && origin.part.kind === 'hole') {
        return { node, part: origin.part };
      }
    }
  }
  return null;
}

/** 穴の中心（mm）。位置は transform が持っている */
export function holeCenter(node: PathNode): Point {
  return M.apply(node.transform, { x: 0, y: 0 });
}

/**
 * いまの穴が、切る線のふちからどれだけ離れているか（mm）。
 * 負なら食い込んでいる。切る線がまだ無いときは null。
 */
export function holeMargin(d: Doc, node: PathNode, part: HolePart): number | null {
  const polys = cutlinePolygons(d);
  if (polys.length === 0) return null;
  return clearance(holeCenter(node), polys) - part.diameterMm / 2;
}

export type HoleShape =
  | { ok: true; transform: Matrix; subpaths: SubPath[]; part: HolePart }
  | { ok: false; bestMarginMm: number };

/**
 * 穴の形と置き場所を決める。
 *
 * keepCenter を渡すと、そこが条件を満たしているあいだは動かさない。
 * 大きさを少し変えただけで、手で置き直した穴が飛んでいっては困るため。
 */
export function buildHole(d: Doc, part: HolePart, keepCenter?: Point | null): HoleShape {
  const polys = cutlinePolygons(d);
  if (polys.length === 0) return { ok: false, bestMarginMm: -Infinity };

  const subpaths = [circleSubPath(part.diameterMm / 2)];

  if (keepCenter) {
    const margin = clearance(keepCenter, polys) - part.diameterMm / 2;
    if (margin >= part.marginMm) {
      return { ok: true, transform: translate(keepCenter), subpaths, part };
    }
  }

  const placed = placeHole(polys, { diameterMm: part.diameterMm, marginMm: part.marginMm });
  if (!placed.ok) return { ok: false, bestMarginMm: placed.bestMarginMm };

  return { ok: true, transform: translate(placed.center), subpaths, part };
}

/** 置き場所の決まった穴を、新しいノードにする */
export function newHoleNode(shape: Extract<HoleShape, { ok: true }>, name: string): PathNode {
  return {
    id: uid('nd'),
    type: 'path',
    name,
    visible: true,
    locked: false,
    transform: shape.transform,
    subpaths: shape.subpaths,
    // 切る線と同じ色にする。加工機は色で加工を振り分けるため（SPEC 8.1）
    fill: null,
    stroke: { color: '#FF00FF', widthMm: 0.1, opacity: 1 },
    origin: { type: 'part', part: shape.part },
  };
}

/**
 * 押した場所に置く（「穴」の道具）。
 * 切る線があればその内側に寄せる。まだ無ければ押した場所にそのまま置き、
 * 切る線ができたあとにチェックで見る。
 */
export function buildHoleAt(d: Doc, part: HolePart, target: Point): HoleShape {
  const subpaths = [circleSubPath(part.diameterMm / 2)];
  const polys = cutlinePolygons(d);
  if (polys.length === 0) return { ok: true, transform: translate(target), subpaths, part };

  const placed = placeHoleNear(polys, { diameterMm: part.diameterMm, marginMm: part.marginMm }, target);
  if (!placed.ok) return { ok: false, bestMarginMm: placed.bestMarginMm };
  return { ok: true, transform: translate(placed.center), subpaths, part };
}

/**
 * 位置はそのままに、大きさだけ作り直す。
 *
 * 置ける場所が無くなったときにも使う。値を無視して黙って戻すより、
 * 言われたとおりの大きさにしてチェックで理由を出したほうが分かる。
 */
export function resizeHoleInPlace(
  node: PathNode,
  part: HolePart,
): Extract<HoleShape, { ok: true }> {
  return {
    ok: true,
    transform: node.transform,
    subpaths: [circleSubPath(part.diameterMm / 2)],
    part,
  };
}

export function defaultHolePart(): HolePart {
  return { kind: 'hole', ...DEFAULT_HOLE_PART };
}

function translate(p: Point): Matrix {
  return M.compose(p.x, p.y, 0);
}
