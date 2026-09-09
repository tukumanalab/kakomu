/**
 * 表示の状態。
 * ここだけが「mm ↔ 画面ピクセル」の変換を知っている。
 * ドキュメント側は mm しか持たない。
 */

import { createSignal } from 'solid-js';
import type { Canvas, Point } from '~/document/types';

export interface View {
  /** ビューポート左上の mm 座標 */
  x: number;
  y: number;
  /** 1mm あたりの画面ピクセル数 */
  scale: number;
}

const [view, setView] = createSignal<View>({ x: -10, y: -10, scale: 4 });
const [size, setSize] = createSignal({ width: 800, height: 600 });

export { view, size, setSize };

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 80;

export function viewBox(): string {
  const v = view();
  const s = size();
  return `${v.x} ${v.y} ${s.width / v.scale} ${s.height / v.scale}`;
}

/** 画面座標（要素内 px）→ mm */
export function toMm(px: number, py: number): Point {
  const v = view();
  return { x: v.x + px / v.scale, y: v.y + py / v.scale };
}

/** mm の長さ → 画面 px */
export function mmToScreen(mm: number): number {
  return mm * view().scale;
}

/** 画面 px の長さ → mm。ハンドルを常に同じ大きさに見せるのに使う */
export function screenToMm(px: number): number {
  return px / view().scale;
}

export function panBy(dxPx: number, dyPx: number): void {
  const v = view();
  setView({ ...v, x: v.x - dxPx / v.scale, y: v.y - dyPx / v.scale });
}

/** 指定した画面位置を固定したままズームする */
export function zoomAt(px: number, py: number, factor: number): void {
  const v = view();
  const next = clampScale(v.scale * factor);
  if (next === v.scale) return;
  const mx = v.x + px / v.scale;
  const my = v.y + py / v.scale;
  setView({ scale: next, x: mx - px / next, y: my - py / next });
}

/** 画面中央を固定してズーム（ボタン操作用） */
export function zoomByStep(factor: number): void {
  const s = size();
  zoomAt(s.width / 2, s.height / 2, factor);
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** 板全体が見えるように合わせる */
export function fitCanvas(canvas: Canvas): void {
  const s = size();
  const margin = 40;
  const w = canvas.widthMm + canvas.bleedMm * 2;
  const h = canvas.heightMm + canvas.bleedMm * 2;
  const scale = clampScale(
    Math.min((s.width - margin * 2) / w, (s.height - margin * 2) / h),
  );
  setView({
    scale,
    x: canvas.widthMm / 2 - s.width / scale / 2,
    y: canvas.heightMm / 2 - s.height / scale / 2,
  });
}

/** 実寸表示。画面の物理 dpi は分からないので 96dpi と仮定する */
const ASSUMED_SCREEN_DPI = 96;

export function zoomToActualSize(): void {
  const s = size();
  const scale = clampScale((ASSUMED_SCREEN_DPI / 25.4) * (window.devicePixelRatio > 1 ? 1 : 1));
  const v = view();
  const cx = v.x + s.width / v.scale / 2;
  const cy = v.y + s.height / v.scale / 2;
  setView({ scale, x: cx - s.width / scale / 2, y: cy - s.height / scale / 2 });
}

/** 状態バーに出す倍率（%） */
export function zoomPercent(): number {
  return Math.round((view().scale / (ASSUMED_SCREEN_DPI / 25.4)) * 100);
}
