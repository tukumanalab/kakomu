/**
 * 部品（いまはキーホルダーの穴だけ）の組み立て。
 *
 * 置く場所を決めるのはジオメトリ側（geometry/hole.ts）の仕事で、
 * ここはそれをドキュメントのノードに変換するところを受け持つ。
 */

import { circleSubPath, clearance, cutlinePolygons, flattenSubpaths, placeHole } from '~/geometry/hole';
import * as M from '~/geometry/matrix';
import { uid } from './store';
import type { Doc, HolePart, Matrix, NodeId, PathNode, Point, SubPath } from './types';
import { DEFAULT_HOLE_PART } from './types';

export interface FoundHole {
  node: PathNode;
  part: HolePart;
}

/** 部品のレイヤーにある穴、ぜんぶ */
export function findHoles(d: Doc): FoundHole[] {
  const out: FoundHole[] = [];
  for (const layer of d.layers) {
    if (layer.role !== 'parts') continue;
    for (const node of layer.nodes) {
      if (node.type !== 'path') continue;
      const origin = node.origin;
      if (origin?.type === 'part' && origin.part.kind === 'hole') {
        out.push({ node, part: origin.part });
      }
    }
  }
  return out;
}

/** id の穴。id を省くと最初の穴 */
export function findHole(d: Doc, id?: NodeId | null): FoundHole | null {
  const holes = findHoles(d);
  if (id === undefined) return holes[0] ?? null;
  return holes.find((h) => h.node.id === id) ?? null;
}

/**
 * 穴を置くときに避けるもの。切る線に、ほかの穴を足したもの。
 *
 * 穴の円をそのまま折れ線に加えると、交差数の偶奇でその中は「外」になり、
 * 距離もその円のふちまでで測られる。つまり穴どうしも
 * 「ふちからの距離」ぶん離れることになる。板は穴と穴のあいだでも折れる。
 */
function obstacles(d: Doc, except?: NodeId): Point[][] {
  const polys = cutlinePolygons(d);
  for (const h of findHoles(d)) {
    if (h.node.id === except) continue;
    polys.push(...flattenSubpaths(h.node.subpaths, h.node.transform));
  }
  return polys;
}

/** 穴の中心（mm）。位置は transform が持っている */
export function holeCenter(node: PathNode): Point {
  return M.apply(node.transform, { x: 0, y: 0 });
}

export interface HoleMargins {
  /** 切る線のふちまで */
  cutline: number;
  /** ほかの穴も含めた、いちばん近いものまで */
  all: number;
}

/**
 * 切る線までと、ほかの穴も含めた距離を分けて返す。
 * どちらが近いかで、出す文言が変わる（はみ出し／穴どうしが近い）。
 */
export function holeMargins(d: Doc, node: PathNode, part: HolePart): HoleMargins | null {
  const cut = cutlinePolygons(d);
  if (cut.length === 0) return null;
  const c = holeCenter(node);
  const r = part.diameterMm / 2;
  return {
    cutline: clearance(c, cut) - r,
    all: clearance(c, obstacles(d, node.id)) - r,
  };
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
export function buildHole(
  d: Doc,
  part: HolePart,
  keepCenter?: Point | null,
  except?: NodeId,
): HoleShape {
  if (cutlinePolygons(d).length === 0) return { ok: false, bestMarginMm: -Infinity };
  const polys = obstacles(d, except);

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
 *
 * 寄せない。押したところが条件を満たさなくても、そのまま置く。
 * 押した場所と違うところに現れると「ずれた」としか見えないため。
 * ふちに近すぎる・はみ出している、はチェックがその場で出す。
 */
export function buildHoleAt(part: HolePart, target: Point): Extract<HoleShape, { ok: true }> {
  return {
    ok: true,
    transform: translate(target),
    subpaths: [circleSubPath(part.diameterMm / 2)],
    part,
  };
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
