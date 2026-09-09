import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import Canvas from '~/canvas/Canvas';
import { Inspector } from '~/panels/Inspector';
import { StatusBar } from '~/panels/StatusBar';
import { TopBar, ToolRail } from '~/panels/Toolbar';
import type { ToolId } from '~/panels/Toolbar';
import { initI18n, t } from './i18n';
import { doc, redo, run, selection, uid, undo } from '~/document/store';
import { deleteNode, importImage as importImageCommand } from '~/document/commands';
import type { Asset, ImageNode } from '~/document/types';
import { ASSUMED_DPI, pxToMm } from '~/document/types';
import { importImage, pickImageFile } from '~/ipc';
import * as M from '~/geometry/matrix';

export default function App() {
  const [tool, setTool] = createSignal<ToolId>('select');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const hasArtwork = () => doc().layers.some((l) => l.role === 'artwork' && l.nodes.length > 0);

  onMount(() => {
    initI18n();

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const inField = (e.target as HTMLElement | null)?.tagName === 'INPUT';
      if (inField) return;

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
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    try {
      const path = await pickImageFile();
      if (path) await placeImage(path);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <div class="app">
      <TopBar onImport={() => void onImport()} busy={busy()} hasArtwork={hasArtwork()} />
      <ToolRail active={tool()} onChange={setTool} />
      <Canvas onRequestImport={() => void onImport()} />
      <Inspector />
      <StatusBar />

      <Show when={error()}>
        {(msg) => (
          <div
            class="issue error"
            style={{
              position: 'fixed',
              top: '52px',
              left: '50%',
              transform: 'translateX(-50%)',
              'z-index': 20,
              'max-width': '520px',
              'box-shadow': '0 2px 12px rgba(0,0,0,.18)',
            }}
            onClick={() => setError(null)}
          >
            <span class="mark">×</span>
            <span>{msg()}</span>
          </div>
        )}
      </Show>

      {/* つぎにやることを常に見せる（SPEC 9.2） */}
      <Show when={hasArtwork()}>
        <div class="next-hint">{t('next.removeBg')}</div>
      </Show>
    </div>
  );
}
