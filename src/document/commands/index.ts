/**
 * 履歴に積むコマンド。
 * apply / revert は純粋関数で、Doc を受け取って新しい Doc を返す。
 */

import type { Command } from '../store';
import { withAsset, withNode, withNodeAdded, withNodeRemoved, withLayer, findNode } from '../store';
import type { Asset, Doc, ImageNode, LayerRole, Matrix, Node, NodeId } from '../types';

/** 絵を入れる */
export function importImage(asset: Asset, node: ImageNode): Command {
  return {
    labelKey: 'cmd.import',
    apply: (d) => withNodeAdded(withAsset(d, asset), 'artwork', node),
    // アセットは消さない。元画像は非破壊で残す方針のため、
    // やりなおしたときに再読み込みが要らないほうが速い。
    revert: (d) => withNodeRemoved(d, node.id),
  };
}

/** ノードの姿勢（位置・回転）を変える */
export function setTransform(
  id: NodeId,
  before: Matrix,
  after: Matrix,
  labelKey: string,
  coalesceKey?: string,
): Command {
  return {
    labelKey,
    coalesceKey,
    apply: (d) => withNode(d, id, (n) => ({ ...n, transform: after })),
    revert: (d) => withNode(d, id, (n) => ({ ...n, transform: before })),
  };
}

/** 画像の配置サイズ（mm）を変える。位置も同時に動くことがある */
export function setImageBox(
  id: NodeId,
  before: { transform: Matrix; widthMm: number; heightMm: number },
  after: { transform: Matrix; widthMm: number; heightMm: number },
  coalesceKey?: string,
): Command {
  const set = (v: typeof before) => (d: Doc) =>
    withNode(d, id, (n) =>
      n.type === 'image' ? { ...n, transform: v.transform, widthMm: v.widthMm, heightMm: v.heightMm } : n,
    );
  return { labelKey: 'cmd.resize', coalesceKey, apply: set(after), revert: set(before) };
}

/** ノードを消す。戻せるように、元の場所も覚えておく */
export function deleteNode(d: Doc, id: NodeId): Command | null {
  const found = findNode(d, id);
  if (!found) return null;
  const role: LayerRole = found.layer.role;
  const index = found.layer.nodes.findIndex((n) => n.id === id);
  const node: Node = found.node;
  return {
    labelKey: 'cmd.delete',
    apply: (doc) => withNodeRemoved(doc, id),
    revert: (doc) => ({
      ...doc,
      layers: doc.layers.map((l) =>
        l.role === role ? { ...l, nodes: [...l.nodes.slice(0, index), node, ...l.nodes.slice(index)] } : l,
      ),
    }),
  };
}

export function toggleLayerVisible(layerId: string, next: boolean): Command {
  return {
    labelKey: 'cmd.toggleVisible',
    apply: (d) => withLayer(d, layerId, (l) => ({ ...l, visible: next })),
    revert: (d) => withLayer(d, layerId, (l) => ({ ...l, visible: !next })),
  };
}

export function toggleLayerLocked(layerId: string, next: boolean): Command {
  return {
    labelKey: 'cmd.toggleVisible',
    apply: (d) => withLayer(d, layerId, (l) => ({ ...l, locked: next })),
    revert: (d) => withLayer(d, layerId, (l) => ({ ...l, locked: !next })),
  };
}
