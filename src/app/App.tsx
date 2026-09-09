import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import Canvas from '~/canvas/Canvas';
import { Inspector } from '~/panels/Inspector';
import { StatusBar } from '~/panels/StatusBar';
import { TopBar, ToolRail } from '~/panels/Toolbar';
import type { ToolId } from '~/panels/Toolbar';
import { initI18n, t } from './i18n';
import {
  doc,
  findNode,
  redo,
  run,
  selectOnly,
  selection,
  uid,
  undo,
} from '~/document/store';
import {
  applyMatting,
  deleteNode,
  importImage as importImageCommand,
} from '~/document/commands';
import type { Asset, ImageNode } from '~/document/types';
import { ASSUMED_DPI, pxToMm } from '~/document/types';
import { importImage, pickImageFile, removeBackground } from '~/ipc';
import type { MattingProgress } from '~/ipc';
import {
  edgeTighten,
  mattingModel,
  mattingProgress,
  refreshModels,
  setCompareOriginal,
  setMattingProgress,
} from './session';
import * as M from '~/geometry/matrix';

export default function App() {
  const [tool, setTool] = createSignal<ToolId>('select');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const imageNodes = createMemo<ImageNode[]>(() =>
    doc()
      .layers.filter((l) => l.role === 'artwork')
      .flatMap((l) => l.nodes)
      .filter((n): n is ImageNode => n.type === 'image'),
  );

  const hasArtwork = () => imageNodes().length > 0;
  const everythingCutOut = () => hasArtwork() && imageNodes().every((n) => n.matting);

  onMount(() => {
    initI18n();
    void refreshModels();

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = selection()[0];
        if (!id) return;
        e.preventDefault();
        const cmd = deleteNode(doc(), id);
        if (cmd) run(cmd);
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));

    // ウィンドウへのドラッグ & ドロップ。Tauri の外（pnpm dev）では黙って諦める
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload as { type: string; paths?: string[] };
          if (payload.type === 'drop' && payload.paths?.length) {
            void placeImage(payload.paths[0]!);
          }
        });
      } catch {
        // ブラウザで開いているときはドロップ連携なしで動く
      }
    })();
    onCleanup(() => unlisten?.());
  });

  /** 実寸を決めて、板の中央に置く */
  async function placeImage(path: string) {
    setBusy(true);
    setError(null);
    try {
      const asset: Asset = await importImage(path);
      const dpi = asset.dpi ?? ASSUMED_DPI;
      let widthMm = pxToMm(asset.widthPx, dpi);
      let heightMm = pxToMm(asset.heightPx, dpi);

      // 板からはみ出すなら、収まるところまで縮めて置く
      const c = doc().canvas;
      const fit = Math.min(c.widthMm / widthMm, c.heightMm / heightMm, 1);
      widthMm *= fit;
      heightMm *= fit;

      const node: ImageNode = {
        id: uid('nd'),
        type: 'image',
        name: asset.originalName,
        visible: true,
        locked: false,
        transform: M.compose((c.widthMm - widthMm) / 2, (c.heightMm - heightMm) / 2, 0),
        assetId: asset.id,
        widthMm,
        heightMm,
      };
      run(importImageCommand(asset, node));
      selectOnly(node.id);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    try {
      const path = await pickImageFile();
      if (path) await placeImage(path);
    } catch (e) {
      setError(message(e));
    }
  }

  /**
   * 背景を消す。
   * かならず元画像から処理するので、モデルを変えて何度でもやり直せる。
   */
  async function onRemoveBackground() {
    const node = targetImage();
    if (!node) return;
    const original = doc().assets[node.assetId];
    if (!original) return;

    setBusy(true);
    setError(null);
    setCompareOriginal(false);
    setMattingProgress({ stage: 'load' });
    try {
      const cutout = await removeBackground(
        original.path,
        { model: mattingModel(), edgeTighten: edgeTighten() },
        (p: MattingProgress) => setMattingProgress(p),
      );
      run(applyMatting(node.id, cutout, mattingModel(), node.matting));
      selectOnly(node.id);
    } catch (e) {
      setError(message(e));
    } finally {
      setMattingProgress(null);
      setBusy(false);
      void refreshModels();
    }
  }

  /** 選んでいるものを優先し、無ければ絵が 1 枚だけならそれを使う */
  function targetImage(): ImageNode | null {
    const id = selection()[0];
    if (id) {
      const found = findNode(doc(), id);
      if (found && found.node.type === 'image') return found.node;
    }
    const nodes = imageNodes();
    return nodes.length === 1 ? nodes[0]! : null;
  }

  return (
    <div class="app">
      <TopBar
        onImport={() => void onImport()}
        onRemoveBackground={() => void onRemoveBackground()}
        busy={busy()}
        hasArtwork={hasArtwork()}
        canRemoveBackground={targetImage() !== null}
      />
      <ToolRail active={tool()} onChange={setTool} />
      <Canvas onRequestImport={() => void onImport()} />
      <Inspector />
      <StatusBar />

      <Show when={mattingProgress()}>{(p) => <ProgressOverlay progress={p()} />}</Show>

      <Show when={error()}>
        {(msg) => (
          <div class="toast issue error" onClick={() => setError(null)}>
            <span class="mark">×</span>
            <span>{msg()}</span>
          </div>
        )}
      </Show>

      {/* つぎにやることを常に見せる（SPEC 9.2） */}
      <Show when={hasArtwork() && !mattingProgress()}>
        <div class="next-hint">
          {everythingCutOut() ? t('next.cutline') : t('next.removeBg')}
        </div>
      </Show>
    </div>
  );
}

/**
 * 子どもは 10 秒の無反応を「壊れた」と判断する。
 * いま何をしているかを必ず出す（SPEC 11.1）。
 */
function ProgressOverlay(props: { progress: MattingProgress }) {
  const label = () => {
    switch (props.progress.stage) {
      case 'download':
        return t('matting.download');
      case 'load':
        return t('matting.load');
      case 'infer':
        return t('matting.infer');
      case 'compose':
        return t('matting.compose');
    }
  };

  const percent = () =>
    props.progress.stage === 'download' ? props.progress.percent : null;

  return (
    <div class="overlay">
      <div class="overlay-box">
        <p class="overlay-label">{label()}</p>
        <div class="bar">
          <div
            class="fill"
            classList={{ indeterminate: percent() === null }}
            style={percent() !== null ? { width: `${percent()}%` } : undefined}
          />
        </div>
        <Show when={props.progress.stage === 'download'}>
          <p class="overlay-sub">
            {(props.progress as { mb: number }).mb.toFixed(1)} /{' '}
            {(props.progress as { totalMb: number }).totalMb.toFixed(1)} MB
          </p>
        </Show>
      </div>
    </div>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
