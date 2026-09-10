/**
 * 履歴に積むコマンド。
 * apply / revert は純粋関数で、Doc を受け取って新しい Doc を返す。
 */

import type { Command } from '../store';
import { withAsset, withNode, withNodeAdded, withNodeRemoved, withLayer, findNode } from '../store';
import type {
  Asset,
  Doc,
  HolePart,
  ImageNode,
  LayerRole,
  Matrix,
  Node,
  NodeId,
  PathNode,
  SubPath,
} from '../types';

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

/**
 * 背景を消した結果を当てる。
 * 元画像も元のアセットも消さないので、もどせば必ず元に戻る（SPEC 7.2）。
 */
export function applyMatting(
  id: NodeId,
  cutout: Asset,
  model: string,
  before: ImageNode['matting'],
): Command {
  return {
    labelKey: 'cmd.removeBg',
    apply: (d) =>
      withNode(withAsset(d, cutout), id, (n) =>
        n.type === 'image'
          ? { ...n, matting: { model, resultAssetId: cutout.id } }
          : n,
      ),
    revert: (d) => withNode(d, id, (n) => (n.type === 'image' ? { ...n, matting: before } : n)),
  };
}

/**
 * 切る線を置く。
 * 絵と同じ transform を持たせるので、生成した座標がそのまま重なる。
 * できたものは普通のパスなので、そのまま点をドラッグして直せる（SPEC 7.4）。
 */
export function addCutline(node: PathNode, replacing: NodeId | null): Command {
  return {
    labelKey: 'cmd.makeCutline',
    apply: (d) => {
      const cleared = replacing ? withNodeRemoved(d, replacing) : d;
      return withNodeAdded(cleared, 'cutline', node);
    },
    revert: (d) => withNodeRemoved(d, node.id),
  };
}

/**
 * キーホルダーの穴を置く。
 *
 * 部品のレイヤーに、それ自身のノードとして入れる（SPEC 7.7 の役割分け）。
 * 書き出しでは切る線と同じ群・同じ色にまとまるので、加工機からは
 * ひとつづきの切るデータに見える（SPEC 7.6）。
 */
export function addHole(node: PathNode, replacing: NodeId | null): Command {
  return {
    labelKey: 'cmd.makeHole',
    apply: (d) => {
      const cleared = replacing ? withNodeRemoved(d, replacing) : d;
      return withNodeAdded(cleared, 'parts', node);
    },
    revert: (d) => withNodeRemoved(d, node.id),
  };
}

/**
 * 穴の大きさや位置を変える。
 * 部品はパラメトリックなので、値を変えたらその場で作り直す（SPEC 7.6）。
 */
export function updateHole(
  id: NodeId,
  before: { transform: Matrix; subpaths: SubPath[]; part: HolePart },
  after: { transform: Matrix; subpaths: SubPath[]; part: HolePart },
  coalesceKey?: string,
): Command {
  const set = (v: typeof before) => (d: Doc) =>
    withNode(d, id, (n) =>
      n.type === 'path'
        ? { ...n, transform: v.transform, subpaths: v.subpaths, origin: { type: 'part', part: v.part } }
        : n,
    );
  return { labelKey: 'cmd.changeHole', coalesceKey, apply: set(after), revert: set(before) };
}

/**
 * 点やハンドルを動かした結果を当てる。
 *
 * 切る線を手で直したら origin.manuallyEdited を立てる。作り直すときに
 * 「手で直したところが元に戻る」と確認を出すため（SPEC 7.4）。
 * 戻したときは、立てる前の値に戻す。
 */
export function editSubpaths(
  id: NodeId,
  before: { subpaths: SubPath[]; manuallyEdited: boolean },
  after: SubPath[],
  labelKey: string,
  coalesceKey?: string,
): Command {
  const set = (subpaths: SubPath[], manuallyEdited: boolean) => (d: Doc) =>
    withNode(d, id, (n) => {
      if (n.type !== 'path') return n;
      const origin =
        n.origin?.type === 'cutline' ? { ...n.origin, manuallyEdited } : n.origin;
      return { ...n, subpaths, origin };
    });
  return {
    labelKey,
    coalesceKey,
    apply: set(after, true),
    revert: set(before.subpaths, before.manuallyEdited),
  };
}
