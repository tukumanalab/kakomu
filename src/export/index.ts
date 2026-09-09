/**
 * 書き出しの段取り。
 *
 * 「両方まとめて書き出す」を主導線にする（SPEC 8.4）。
 * 片方だけ書き出して、もう片方を忘れる事故を防ぐため。
 */

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Doc, ImageNode } from '~/document/types';
import { displayAssetId } from '~/document/store';
import { buildCutlineSvg } from './svg';

export interface ExportResult {
  folder: string;
  svgName: string;
  pdfName: string;
  /** 切る線がまだ無いので、板の外形で代用した */
  usedBoardOutline: boolean;
}

interface Placement {
  path: string;
  transform: number[];
  widthMm: number;
  heightMm: number;
}

interface PageSpec {
  widthMm: number;
  heightMm: number;
  bleedMm: number;
  targetDpi: number;
  images: Placement[];
}

/** 書き出し先を選ばせる。ファイル 2 つを並べて置くのでフォルダを選ぶ */
export async function pickExportFolder(): Promise<string | null> {
  const chosen = await open({ directory: true, multiple: false });
  return typeof chosen === 'string' ? chosen : null;
}

export async function exportBoth(
  doc: Doc,
  folder: string,
  targetDpi = 600,
): Promise<ExportResult> {
  const base = baseName(doc);
  const svgName = `${base}_切る.svg`;
  const pdfName = `${base}_印刷.pdf`;

  const { svg, usedBoardOutline } = buildCutlineSvg(doc);
  await invoke('write_text_file', { path: join(folder, svgName), contents: svg });

  const spec: PageSpec = {
    widthMm: doc.canvas.widthMm,
    heightMm: doc.canvas.heightMm,
    bleedMm: doc.canvas.bleedMm,
    targetDpi,
    images: collectImages(doc),
  };
  await invoke('export_pdf', { spec, path: join(folder, pdfName) });

  return { folder, svgName, pdfName, usedBoardOutline };
}

/** 絵のレイヤーにある画像を、下から順に集める */
function collectImages(doc: Doc): Placement[] {
  const out: Placement[] = [];
  for (const layer of doc.layers) {
    if (layer.role !== 'artwork' || !layer.visible) continue;
    for (const node of layer.nodes) {
      if (node.type !== 'image' || !node.visible) continue;
      const image = node as ImageNode;
      // 背景を消してあればその結果を刷る
      const assetId = displayAssetId(image);
      const asset = assetId ? doc.assets[assetId] : undefined;
      if (!asset) continue;
      out.push({
        path: asset.path,
        transform: [...image.transform],
        widthMm: image.widthMm,
        heightMm: image.heightMm,
      });
    }
  }
  return out;
}

/** 元の画像のファイル名を引き継ぐ。何が何だか分からないファイルを作らない */
function baseName(doc: Doc): string {
  for (const layer of doc.layers) {
    if (layer.role !== 'artwork') continue;
    for (const node of layer.nodes) {
      if (node.type !== 'image') continue;
      const asset = doc.assets[node.assetId];
      const name = asset?.originalName?.replace(/\.[^.]+$/, '');
      if (name) return sanitize(name);
    }
  }
  return 'kakomu';
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'kakomu';
}

function join(folder: string, name: string): string {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return folder.endsWith(sep) ? `${folder}${name}` : `${folder}${sep}${name}`;
}
