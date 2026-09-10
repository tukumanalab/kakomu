/**
 * ドキュメントに保存しない、その場かぎりの UI の状態。
 * 保存対象は document/store.ts 側にしか置かない。
 */

import { createSignal } from 'solid-js';
import { listModels } from '~/ipc';
import type { CutlineIssue, MattingProgress, ModelInfo } from '~/ipc';
import type { HolePart } from '~/document/types';
import { DEFAULT_HOLE_PART } from '~/document/types';

export type MattingModel = 'isnet-general-use' | 'isnet-anime';

/** 既定は写真向け。手元にあるものが何かで選ばせる（速さや精度では選ばせない） */
const [mattingModel, setMattingModel] = createSignal<MattingModel>('isnet-general-use');
const [edgeTighten, setEdgeTighten] = createSignal(0.35);

/** 消す前の絵と見くらべているあいだ true */
const [compareOriginal, setCompareOriginal] = createSignal(false);

/** 切る線の作りかた。SPEC 7.4 の既定値 */
const [cutlineParams, setCutlineParams] = createSignal({
  offsetMm: 3.0,
  alphaThreshold: 128,
  smoothing: 0.5,
  minAreaMm2: 4.0,
  keepHoles: false,
  enforceMinWidth: true,
});

/** 切る線を作っているあいだ true */
const [cutlineBusy, setCutlineBusy] = createSignal(false);

/** 直前に作ったときの検査結果 */
const [cutlineIssues, setCutlineIssues] = createSignal<CutlineIssue[]>([]);
const [cutlineSegments, setCutlineSegments] = createSignal(0);

export {
  cutlineParams,
  setCutlineParams,
  cutlineBusy,
  setCutlineBusy,
  cutlineIssues,
  setCutlineIssues,
  cutlineSegments,
  setCutlineSegments,
};

/** キーホルダーの穴。SPEC 7.6 の既定値 */
const [holePart, setHolePart] = createSignal<HolePart>({
  kind: 'hole',
  ...DEFAULT_HOLE_PART,
});

export { holePart, setHolePart };

/** 実行中だけ値が入る */
const [mattingProgress, setMattingProgress] = createSignal<MattingProgress | null>(null);

/** どのモデルが手元にあるか。まだ無いものは大きさを見せて不意打ちを防ぐ */
const [models, setModels] = createSignal<ModelInfo[]>([]);

export async function refreshModels(): Promise<void> {
  try {
    setModels(await listModels());
  } catch {
    // 一覧が取れなくても、押せば落ちてくるので致命的ではない
  }
}

export { models };

export {
  mattingModel,
  setMattingModel,
  edgeTighten,
  setEdgeTighten,
  compareOriginal,
  setCompareOriginal,
  mattingProgress,
  setMattingProgress,
};
