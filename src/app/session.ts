/**
 * ドキュメントに保存しない、その場かぎりの UI の状態。
 * 保存対象は document/store.ts 側にしか置かない。
 */

import { createSignal } from 'solid-js';
import { listModels } from '~/ipc';
import type { MattingProgress, ModelInfo } from '~/ipc';

export type MattingModel = 'u2netp' | 'isnet-general-use' | 'isnet-anime';

/** 既定は u2netp。4.4MB なので初回でも数秒で終わり、その日のうちに作りおわれる */
const [mattingModel, setMattingModel] = createSignal<MattingModel>('u2netp');
const [edgeTighten, setEdgeTighten] = createSignal(0.35);

/** 消す前の絵と見くらべているあいだ true */
const [compareOriginal, setCompareOriginal] = createSignal(false);

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
