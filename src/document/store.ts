/**
 * ドキュメントの単一の保持場所と、もどす／やりなおす。
 *
 * 履歴はコマンドパターン。画像アセットを含むスナップショットは取らず、
 * 差分だけを持つ（SPEC 6.3）。
 */

import { createSignal, createMemo } from 'solid-js';
import type { Asset, AssetId, Doc, Layer, Node, NodeId, ProductKind } from './types';
import { DEFAULT_CUTLINE_PARAMS } from './types';

export interface Command {
  /** UI に出すラベルの i18n キー */
  labelKey: string;
  apply(doc: Doc): Doc;
  revert(doc: Doc): Doc;
  /** 同じキーの連続操作は 1 つにまとめる（ドラッグ中の移動など） */
  coalesceKey?: string;
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyDoc(kind: ProductKind = 'acrylic-keychain'): Doc {
  const now = new Date().toISOString();
  const layers: Layer[] = [
    { id: uid('ly'), nameKey: 'layer.artwork', role: 'artwork', visible: true, locked: false, opacity: 1, nodes: [] },
    { id: uid('ly'), nameKey: 'layer.cutline', role: 'cutline', visible: true, locked: false, opacity: 1, nodes: [] },
    { id: uid('ly'), nameKey: 'layer.parts', role: 'parts', visible: true, locked: false, opacity: 1, nodes: [] },
  ];
  return {
    version: 2,
    id: uid('doc'),
    meta: { title: '', created: now, modified: now },
    canvas: { widthMm: 80, heightMm: 120, bleedMm: 3 },
    assets: {},
    layers,
    product: {
      kind,
      thicknessMm: 3.0,
      defaultOffsetMm: DEFAULT_CUTLINE_PARAMS.offsetMm,
    },
  };
}

// ---------------------------------------------------------------- state

const [doc, setDoc] = createSignal<Doc>(createEmptyDoc());
const [selection, setSelection] = createSignal<NodeId[]>([]);

interface HistoryEntry {
  command: Command;
}

const [past, setPast] = createSignal<HistoryEntry[]>([]);
const [future, setFuture] = createSignal<HistoryEntry[]>([]);

export { doc, selection };

export const canUndo = createMemo(() => past().length > 0);
export const canRedo = createMemo(() => future().length > 0);
export const undoLabelKey = createMemo(() => past().at(-1)?.command.labelKey ?? '');
export const redoLabelKey = createMemo(() => future().at(-1)?.command.labelKey ?? '');

/**
 * コマンドを実行して履歴に積む。
 * coalesceKey が直前と同じなら、直前のコマンドを置き換える
 * （ドラッグ 1 回が undo 1 回になるように）。
 */
export function run(command: Command): void {
  const before = doc();
  setDoc(touch(command.apply(before)));
  setFuture([]);

  const prev = past().at(-1);
  if (command.coalesceKey && prev?.command.coalesceKey === command.coalesceKey) {
    // 直前のコマンドの revert を残したまま、apply だけを差し替える
    const merged: Command = {
      labelKey: command.labelKey,
      coalesceKey: command.coalesceKey,
      apply: command.apply,
      revert: prev.command.revert,
    };
    setPast([...past().slice(0, -1), { command: merged }]);
  } else {
    setPast([...past(), { command }]);
  }
}

export function undo(): void {
  const entry = past().at(-1);
  if (!entry) return;
  setDoc(touch(entry.command.revert(doc())));
  setPast(past().slice(0, -1));
  setFuture([...future(), entry]);
}

export function redo(): void {
  const entry = future().at(-1);
  if (!entry) return;
  setDoc(touch(entry.command.apply(doc())));
  setFuture(future().slice(0, -1));
  setPast([...past(), entry]);
}

/** 履歴に積まずに直接置き換える（ファイルを開いたときなど） */
export function replaceDoc(next: Doc): void {
  setDoc(next);
  setPast([]);
  setFuture([]);
  setSelection([]);
}

function touch(d: Doc): Doc {
  return { ...d, meta: { ...d.meta, modified: new Date().toISOString() } };
}

// ---------------------------------------------------------------- selection

export function select(ids: NodeId[]): void {
  setSelection(ids);
}

export function selectOnly(id: NodeId | null): void {
  setSelection(id ? [id] : []);
}

export function isSelected(id: NodeId): boolean {
  return selection().includes(id);
}

// ---------------------------------------------------------------- lookup

export function findNode(d: Doc, id: NodeId): { layer: Layer; node: Node } | null {
  for (const layer of d.layers) {
    const node = layer.nodes.find((n) => n.id === id);
    if (node) return { layer, node };
  }
  return null;
}

export function layerByRole(d: Doc, role: Layer['role']): Layer | undefined {
  return d.layers.find((l) => l.role === role);
}

export function allNodes(d: Doc): Node[] {
  return d.layers.flatMap((l) => l.nodes);
}

export function assetOf(d: Doc, node: Node): Asset | undefined {
  return node.type === 'image' ? d.assets[node.assetId] : undefined;
}

/**
 * 画面に出すアセット。背景を消してあればその結果を、
 * 見くらべ中や未処理なら元画像を返す。元画像は必ず残っている。
 */
export function displayAssetId(node: Node, showOriginal = false): AssetId | null {
  if (node.type !== 'image') return null;
  if (!showOriginal && node.matting) return node.matting.resultAssetId;
  return node.assetId;
}

// ---------------------------------------------------------------- 変更ヘルパ

/** 1 つのノードを差し替えた新しい Doc を返す */
export function withNode(d: Doc, id: NodeId, update: (n: Node) => Node): Doc {
  return {
    ...d,
    layers: d.layers.map((layer) => {
      if (!layer.nodes.some((n) => n.id === id)) return layer;
      return { ...layer, nodes: layer.nodes.map((n) => (n.id === id ? update(n) : n)) };
    }),
  };
}

/** 指定した役割のレイヤーにノードを足した新しい Doc を返す */
export function withNodeAdded(d: Doc, role: Layer['role'], node: Node): Doc {
  return {
    ...d,
    layers: d.layers.map((layer) =>
      layer.role === role ? { ...layer, nodes: [...layer.nodes, node] } : layer,
    ),
  };
}

export function withNodeRemoved(d: Doc, id: NodeId): Doc {
  return {
    ...d,
    layers: d.layers.map((layer) => ({ ...layer, nodes: layer.nodes.filter((n) => n.id !== id) })),
  };
}

export function withLayer(d: Doc, id: string, update: (l: Layer) => Layer): Doc {
  return { ...d, layers: d.layers.map((l) => (l.id === id ? update(l) : l)) };
}

export function withAsset(d: Doc, asset: Asset): Doc {
  return { ...d, assets: { ...d.assets, [asset.id]: asset } };
}

export { uid };
