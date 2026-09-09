/**
 * Rust 側との橋渡し。
 * 画像バイナリは IPC に載せず、Rust がキャッシュに複製したパスを受け取って
 * asset プロトコルで表示する（SPEC 5.3）。
 */

import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Asset } from '~/document/types';

interface ImportedImage {
  assetId: string;
  path: string;
  widthPx: number;
  heightPx: number;
  dpi: number | null;
  originalName: string;
}

/** 対応する拡張子。Rust 側の is_supported と揃えておく */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'];

export async function pickImageFile(): Promise<string | null> {
  const chosen = await open({
    multiple: false,
    directory: false,
    filters: [{ name: '画像', extensions: IMAGE_EXTENSIONS }],
  });
  return typeof chosen === 'string' ? chosen : null;
}

export async function importImage(path: string): Promise<Asset> {
  const r = await invoke<ImportedImage>('import_image', { path });
  return {
    id: r.assetId,
    url: convertFileSrc(r.path),
    path: r.path,
    widthPx: r.widthPx,
    heightPx: r.heightPx,
    dpi: r.dpi,
    originalName: r.originalName,
  };
}

/** 共用 PC モードの「おわる」で呼ぶ */
export async function clearWorkspace(): Promise<void> {
  await invoke('clear_workspace');
}

// ---------------------------------------------------------------- 背景除去

export type MattingProgress =
  | { stage: 'download'; percent: number; mb: number; totalMb: number }
  | { stage: 'load' }
  | { stage: 'infer' }
  | { stage: 'compose' };

export interface ModelInfo {
  id: string;
  bytes: number;
  downloaded: boolean;
}

interface CutoutResult {
  assetId: string;
  path: string;
  widthPx: number;
  heightPx: number;
}

export async function listModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('list_models');
}

/**
 * 背景を消す。推論はすべて手元で動き、画像は外に出ない。
 * 元画像は書き換えず、結果を別のアセットとして返す（非破壊）。
 */
export async function removeBackground(
  path: string,
  options: { model: string; edgeTighten: number },
  onProgress: (p: MattingProgress) => void,
): Promise<Asset> {
  const channel = new Channel<MattingProgress>();
  channel.onmessage = onProgress;

  const r = await invoke<CutoutResult>('remove_background', {
    path,
    options,
    onProgress: channel,
  });
  return {
    id: r.assetId,
    url: convertFileSrc(r.path),
    path: r.path,
    widthPx: r.widthPx,
    heightPx: r.heightPx,
    dpi: null,
    originalName: 'cutout.png',
  };
}

// ---------------------------------------------------------------- 切る線

export interface CutlineParams {
  offsetMm: number;
  alphaThreshold: number;
  smoothing: number;
  minAreaMm2: number;
  keepHoles: boolean;
  enforceMinWidth: boolean;
}

export interface CutlineIssue {
  kind: string;
  severity: 'error' | 'warn';
  detail: string | null;
}

interface RawAnchor {
  p: [number, number];
  in: [number, number];
  out: [number, number];
  kind: string;
}

interface RawSubPath {
  closed: boolean;
  anchors: RawAnchor[];
  isHole: boolean;
}

export interface CutlineResult {
  subpaths: RawSubPath[];
  issues: CutlineIssue[];
  segmentCount: number;
}

/**
 * 絵のアルファから切る線を作る。座標は絵のローカル mm で返ってくるので、
 * 絵と同じ transform を持たせれば、そのまま重なる。
 */
export async function generateCutline(
  path: string,
  widthMm: number,
  heightMm: number,
  params: CutlineParams,
): Promise<CutlineResult> {
  return invoke<CutlineResult>('generate_cutline', {
    path,
    widthMm,
    heightMm,
    params,
  });
}
