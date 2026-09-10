/**
 * キーホルダーの穴を、置ける場所に自動で置く。
 *
 * 決まりごと（SPEC 7.6）:
 *   - 穴は φ4mm、穴のふちから切る線のふちまで 3mm 空ける
 *   - 切る線の内側であること。切る線に内輪郭（抜き）があれば、その中は不可
 *   - キーホルダーは上から吊るすので、置ける場所のうち **いちばん上** を選ぶ
 *
 * 距離はベジェを折れ線に割ってから測る。曲線のままの厳密解は要らない。
 * 0.5mm の弦で刻めば誤差は 0.02mm 以下で、レーザーの刃幅（0.1mm 前後）より
 * 細かい。実物では見えない差なので、そのぶん素直な実装にしている。
 */

import type { Doc, Point, SubPath } from '~/document/types';
import { KAPPA } from './path';
import * as M from './matrix';

/** 折れ線に割るときの弦の長さ（mm） */
const CHORD_MM = 0.5;

/** 探索を打ち切る細かさ（mm）。これ以上細かくしても実物では差が出ない */
const FINEST_STEP_MM = 0.05;

export interface HoleSpec {
  /** 穴の直径 */
  diameterMm: number;
  /** 穴のふちから切る線のふちまで空ける距離 */
  marginMm: number;
}

export type Placement =
  | { ok: true; center: Point; marginMm: number }
  | { ok: false; bestMarginMm: number };

// ---------------------------------------------------------------- 折れ線化

/**
 * サブパスを世界座標（mm）の閉じた折れ線にする。
 * 開いたサブパスも閉じたものとして扱う。切る線は必ず閉じているし、
 * 途中まで描きかけの線を「内側」と呼べる形にはできないため。
 */
export function flattenSubpaths(
  subpaths: SubPath[],
  transform: M.Matrix,
  chordMm = CHORD_MM,
): Point[][] {
  const polys: Point[][] = [];

  for (const sub of subpaths) {
    const a = sub.anchors;
    if (a.length < 2) continue;

    const pts: Point[] = [];
    for (let i = 0; i < a.length; i++) {
      const from = a[i]!;
      const to = a[(i + 1) % a.length]!;
      const p0 = M.apply(transform, from.p);
      const p1 = M.apply(transform, { x: from.p.x + from.out.x, y: from.p.y + from.out.y });
      const p2 = M.apply(transform, { x: to.p.x + to.in.x, y: to.p.y + to.in.y });
      const p3 = M.apply(transform, to.p);

      // 制御点をつないだ長さを弦で割る。曲がりが強いほど多く刻まれる
      const rough = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
      const steps = clamp(Math.ceil(rough / chordMm), 1, 64);
      for (let s = 0; s < steps; s++) {
        pts.push(cubicAt(p0, p1, p2, p3, s / steps));
      }
    }
    if (pts.length >= 3) polys.push(pts);
  }
  return polys;
}

/** 切る線のレイヤーにあるパスを、まとめて折れ線にする */
export function cutlinePolygons(doc: Doc): Point[][] {
  const polys: Point[][] = [];
  for (const layer of doc.layers) {
    if (layer.role !== 'cutline' || !layer.visible) continue;
    for (const node of layer.nodes) {
      if (node.type !== 'path' || !node.visible) continue;
      polys.push(...flattenSubpaths(node.subpaths, node.transform));
    }
  }
  return polys;
}

// ---------------------------------------------------------------- 距離

/**
 * 折れ線の縁までの距離。内側なら正、外側なら負。
 *
 * 内外は交差数の偶奇で決める。切る線が内輪郭（抜き）を持つとき、
 * その中は「外」になる。抜きの中に穴を開けたら板が落ちてしまうので、
 * この判定がそのまま正しい。
 */
export function clearance(p: Point, polys: Point[][]): number {
  let best = Infinity;
  let crossings = 0;

  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;

      const d = pointToSegment(p, a, b);
      if (d < best) best = d;

      // 右向きの半直線と交わるか
      if (a.y > p.y !== b.y > p.y) {
        const t = (p.y - a.y) / (b.y - a.y);
        if (p.x < a.x + t * (b.x - a.x)) crossings++;
      }
    }
  }

  if (!Number.isFinite(best)) return -Infinity;
  return crossings % 2 === 1 ? best : -best;
}

// ---------------------------------------------------------------- 配置

/**
 * 穴を置ける場所を探す。
 *
 * 粗い格子でいったん見つけてから、その周りを細かく詰める。
 * 「いちばん上」を先に決め、同じ高さなら横の真ん中に近いほうを取る。
 */
export function placeHole(polys: Point[][], spec: HoleSpec): Placement {
  const radius = spec.diameterMm / 2;
  const need = radius + spec.marginMm;

  const box = bounds(polys);
  if (!box) return { ok: false, bestMarginMm: -Infinity };

  const step = clamp(Math.min(box.w, box.h) / 40, 0.25, 1.0);
  const centerX = box.x + box.w / 2;

  let best: Point | null = null;
  let bestClear = -Infinity;

  for (let y = box.y; y <= box.y + box.h; y += step) {
    // 上から順に見ているので、置ける場所が出た行を調べ終えたらそこで打ち切れる
    if (best && y > best.y) break;

    for (let x = box.x; x <= box.x + box.w; x += step) {
      const c = clearance({ x, y }, polys);
      if (c > bestClear) bestClear = c;
      if (c < need) continue;

      const p = { x, y };
      if (!best || closerToCenter(p, best, centerX)) best = p;
    }
  }

  if (!best) return { ok: false, bestMarginMm: bestClear - radius };

  const refined = refine(best, polys, need, centerX, step);
  return { ok: true, center: refined, marginMm: clearance(refined, polys) - radius };
}

/**
 * 押した場所のなるべく近くに置く（「穴」の道具用）。
 *
 * 押した場所がそのまま条件を満たすならそこに置く。満たさなければ、
 * 置ける場所のうち押した場所にいちばん近いところへ寄せる（SPEC 7.6）。
 * 子どもが切る線のすぐ外を押しても、内側に吸い付く。
 */
export function placeHoleNear(polys: Point[][], spec: HoleSpec, target: Point): Placement {
  const radius = spec.diameterMm / 2;
  const need = radius + spec.marginMm;

  const here = clearance(target, polys);
  if (here >= need) return { ok: true, center: target, marginMm: here - radius };

  const box = bounds(polys);
  if (!box) return { ok: false, bestMarginMm: -Infinity };

  const step = clamp(Math.min(box.w, box.h) / 40, 0.25, 1.0);
  let best: Point | null = null;
  let bestDist = Infinity;
  let bestClear = -Infinity;

  for (let y = box.y; y <= box.y + box.h; y += step) {
    for (let x = box.x; x <= box.x + box.w; x += step) {
      const c = clearance({ x, y }, polys);
      if (c > bestClear) bestClear = c;
      if (c < need) continue;
      const dd = dist({ x, y }, target);
      if (dd < bestDist) {
        bestDist = dd;
        best = { x, y };
      }
    }
  }
  if (!best) return { ok: false, bestMarginMm: bestClear - radius };

  // 押した場所へ向かって、置ける限り詰める
  let cur = best;
  for (let s = step / 2; s >= FINEST_STEP_MM; s /= 2) {
    for (let guard = 0; guard < 64; guard++) {
      const dx = target.x - cur.x;
      const dy = target.y - cur.y;
      const len = Math.hypot(dx, dy);
      if (len <= s) break;
      const cand = { x: cur.x + (dx / len) * s, y: cur.y + (dy / len) * s };
      if (clearance(cand, polys) < need) break;
      cur = cand;
    }
  }
  return { ok: true, center: cur, marginMm: clearance(cur, polys) - radius };
}

/** 上へ、そして真ん中へ、置ける限り寄せる */
function refine(
  start: Point,
  polys: Point[][],
  need: number,
  centerX: number,
  step: number,
): Point {
  let cur = start;

  for (let s = step / 2; s >= FINEST_STEP_MM; s /= 2) {
    // 1 段階ごとに動けなくなるまで詰める。刻みは半分ずつなので回数は限られる
    for (let guard = 0; guard < 64; guard++) {
      const candidates: Point[] = [
        { x: cur.x, y: cur.y - s },
        { x: cur.x + (cur.x > centerX ? -s : s), y: cur.y },
      ];
      const next = candidates.find(
        (p) => clearance(p, polys) >= need && betterThan(p, cur, centerX),
      );
      if (!next) break;
      cur = next;
    }
  }
  return cur;
}

/** 上が優先。ほぼ同じ高さなら、横の真ん中に近いほう */
function betterThan(a: Point, b: Point, centerX: number): boolean {
  if (a.y < b.y - 1e-9) return true;
  if (a.y > b.y + 1e-9) return false;
  return closerToCenter(a, b, centerX);
}

function closerToCenter(a: Point, b: Point, centerX: number): boolean {
  return Math.abs(a.x - centerX) < Math.abs(b.x - centerX);
}

// ---------------------------------------------------------------- 円

/**
 * 原点を中心にした円。4 本の三次ベジェで書く（SPEC 7.6）。
 * 位置はノードの transform 側で持つので、ここでは原点に置く。
 */
export function circleSubPath(radiusMm: number): SubPath {
  const r = radiusMm;
  const k = r * KAPPA;
  return {
    closed: true,
    anchors: [
      { p: { x: r, y: 0 }, in: { x: 0, y: -k }, out: { x: 0, y: k }, kind: 'smooth' },
      { p: { x: 0, y: r }, in: { x: k, y: 0 }, out: { x: -k, y: 0 }, kind: 'smooth' },
      { p: { x: -r, y: 0 }, in: { x: 0, y: k }, out: { x: 0, y: -k }, kind: 'smooth' },
      { p: { x: 0, y: -r }, in: { x: -k, y: 0 }, out: { x: k, y: 0 }, kind: 'smooth' },
    ],
  };
}

// ---------------------------------------------------------------- 補助

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function bounds(polys: Point[][]): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function pointToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = clamp(t, 0, 1);
  return dist(p, { x: a.x + t * vx, y: a.y + t * vy });
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
