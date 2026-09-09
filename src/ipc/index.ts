/**
 * Rust 側との橋渡し。
 * 画像バイナリは IPC に載せず、Rust がキャッシュに複製したパスを受け取って
 * asset プロトコルで表示する（SPEC 5.3）。
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
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
