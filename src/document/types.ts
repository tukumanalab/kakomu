/**
 * ドキュメントモデル。
 *
 * 最も重要な規則: **座標・寸法はすべて mm の実寸で保持する**。
 * ピクセルはレンダリング時にのみ登場し、この型には現れない。
 * 唯一の例外は Asset.widthPx / heightPx で、これは元画像の素の大きさを
 * 記録するためのもの（実効解像度の算出に使う）。
 */

export type AssetId = string;
export type LayerId = string;
export type NodeId = string;

/** mm 座標 */
export interface Point {
  x: number;
  y: number;
}

/** 親座標系への affine 変換 [a, b, c, d, e, f]。e/f は mm */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// ---------------------------------------------------------------- assets

export interface Asset {
  id: AssetId;
  /** 表示用の URL（Tauri の asset プロトコル） */
  url: string;
  /** ローカルの実ファイルパス。.kkm 保存時に読み出す */
  path: string;
  /** 元画像の素の大きさ。実効解像度の算出にだけ使う */
  widthPx: number;
  heightPx: number;
  /** 画像に埋め込まれていた解像度。不明なら null */
  dpi: number | null;
  /** 取り込み元のファイル名。UI 表示用 */
  originalName: string;
}

// ---------------------------------------------------------------- geometry

export type AnchorKind = 'corner' | 'smooth' | 'symmetric';

export interface Anchor {
  /** アンカー点（mm） */
  p: Point;
  /** 入りハンドル（p からの相対、mm） */
  in: Point;
  /** 出ハンドル（p からの相対、mm） */
  out: Point;
  kind: AnchorKind;
}

export interface SubPath {
  closed: boolean;
  anchors: Anchor[];
}

export interface Paint {
  color: string;
  opacity: number;
}

export interface Stroke {
  color: string;
  /** 線幅（mm） */
  widthMm: number;
  opacity: number;
}

// ---------------------------------------------------------------- nodes

interface NodeBase {
  id: NodeId;
  name: string;
  visible: boolean;
  locked: boolean;
  transform: Matrix;
}

export interface ImageNode extends NodeBase {
  type: 'image';
  assetId: AssetId;
  /** 配置サイズ（mm）。元画像の px とは独立 */
  widthMm: number;
  heightMm: number;
  /** 背景を消した結果。元アセットは常に残す（非破壊） */
  matting?: {
    model: string;
    resultAssetId: AssetId;
  };
}

/** 切る線の生成元。パラメータを変えて再生成できるように保持する */
export interface CutlineOrigin {
  type: 'cutline';
  sourceNodeId: NodeId;
  params: CutlineParams;
  /** 手で編集された後か。true なら再生成時に確認する */
  manuallyEdited: boolean;
}

export interface CutlineParams {
  /** ふちの太さ */
  offsetMm: number;
  /** 0-255 */
  alphaThreshold: number;
  /** 0 = 忠実, 1 = なめらか */
  smoothing: number;
  /** これ未満の孤立した島を無視する */
  minAreaMm2: number;
  keepHoles: boolean;
  joinStyle: 'round' | 'miter';
  /** 折れやすい細部を自動で太らせる */
  enforceMinWidth: boolean;
}

export const DEFAULT_CUTLINE_PARAMS: CutlineParams = {
  offsetMm: 3.0,
  alphaThreshold: 128,
  smoothing: 0.5,
  minAreaMm2: 4.0,
  keepHoles: false,
  joinStyle: 'round',
  enforceMinWidth: true,
};

export interface PartOrigin {
  type: 'part';
  part: HolePart | StandPart;
}

export interface HolePart {
  kind: 'hole';
  diameterMm: number;
  /** 穴の中心から切る線の縁までの最小距離 */
  marginMm: number;
  center: Point;
}

export interface StandPart {
  kind: 'stand';
  shape: 'rounded-rect' | 'ellipse' | 'trapezoid';
  widthMm: number;
  heightMm: number;
  cornerRadiusMm: number;
  slot: {
    /** アクリル厚 + クリアランス */
    widthMm: number;
    lengthMm: number;
    roundedEnds: boolean;
  };
}

export interface PathNode extends NodeBase {
  type: 'path';
  subpaths: SubPath[];
  fill: Paint | null;
  stroke: Stroke | null;
  origin?: CutlineOrigin | PartOrigin;
}

export interface GroupNode extends NodeBase {
  type: 'group';
  children: Node[];
}

export type Node = ImageNode | PathNode | GroupNode;

// ---------------------------------------------------------------- layers

/** レイヤーの役割。書き出しの振り分けに使うため、後から変更できない */
export type LayerRole = 'artwork' | 'cutline' | 'parts' | 'guide';

export interface Layer {
  id: LayerId;
  /** i18n キー。既定レイヤーは翻訳され、ユーザー作成レイヤーは生の文字列 */
  nameKey: string;
  role: LayerRole;
  visible: boolean;
  locked: boolean;
  opacity: number;
  nodes: Node[];
}

// ---------------------------------------------------------------- document

export type ProductKind = 'acrylic-keychain' | 'acrylic-stand' | 'custom';

export interface ProductSettings {
  kind: ProductKind;
  /** アクリル板の厚み。台座スリット幅の計算に使う */
  thicknessMm: number;
  /** 切る線の標準的なふちの太さ */
  defaultOffsetMm: number;
}

export interface Canvas {
  widthMm: number;
  heightMm: number;
  /** 塗り足し */
  bleedMm: number;
}

export interface Doc {
  version: 2;
  id: string;
  meta: {
    title: string;
    created: string;
    modified: string;
  };
  canvas: Canvas;
  assets: Record<AssetId, Asset>;
  layers: Layer[];
  product: ProductSettings;
}

// ---------------------------------------------------------------- 定数

/** 画像に解像度が書かれていないときの仮定値 */
export const ASSUMED_DPI = 350;

/** これを下回ると「絵があらくなる」と警告する */
export const MIN_PRINT_DPI = 300;

/** アクリル加工で折れずに残る最小の幅 */
export const MIN_FEATURE_WIDTH_MM = 1.5;

/** 刃が入る最小の穴径 */
export const MIN_HOLE_DIAMETER_MM = 2.0;

export const MM_PER_INCH = 25.4;

export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * MM_PER_INCH;
}

export function mmToPx(mm: number, dpi: number): number {
  return (mm / MM_PER_INCH) * dpi;
}

/** 配置サイズに対する実効解像度（dpi） */
export function effectiveDpi(widthPx: number, widthMm: number): number {
  if (widthMm <= 0) return 0;
  return (widthPx / widthMm) * MM_PER_INCH;
}
