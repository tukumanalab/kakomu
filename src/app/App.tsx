import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import Canvas from '~/canvas/Canvas';
import { Inspector } from '~/panels/Inspector';
import { StatusBar } from '~/panels/StatusBar';
import { TopBar, ToolRail } from '~/panels/Toolbar';
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
  addCutline,
  addHole,
  applyMatting,
  deleteNode,
  editSubpaths,
  importImage as importImageCommand,
  updateHole,
} from '~/document/commands';
import { deleteAnchor } from '~/geometry/edit';
import { buildHole, buildHoleAt, findHole, newHoleNode } from '~/document/parts';
import type { Anchor, Asset, ImageNode, PathNode, Point } from '~/document/types';
import { ASSUMED_DPI, pxToMm } from '~/document/types';
import { generateCutline, importImage, pickImageFile, removeBackground } from '~/ipc';
import type { MattingProgress } from '~/ipc';
import { exportBoth, pickExportFolder } from '~/export';
import type { ExportResult } from '~/export';
import {
  cutlineBusy,
  cutlineParams,
  edgeTighten,
  holePart,
  mattingModel,
  mattingProgress,
  refreshModels,
  selectedAnchor,
  setCompareOriginal,
  setCutlineBusy,
  setCutlineIssues,
  setCutlineSegments,
  setMattingProgress,
  setSelectedAnchor,
  setTool,
  tool,
} from './session';
import type { ToolId } from './session';
import * as M from '~/geometry/matrix';

export default function App() {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [exported, setExported] = createSignal<ExportResult | null>(null);
  /** 手で直した切る線を作り直してよいか、聞いているあいだ true */
  const [confirmRemake, setConfirmRemake] = createSignal(false);

  const imageNodes = createMemo<ImageNode[]>(() =>
    doc()
      .layers.filter((l) => l.role === 'artwork')
      .flatMap((l) => l.nodes)
      .filter((n): n is ImageNode => n.type === 'image'),
  );

  const hasArtwork = () => imageNodes().length > 0;
  const everythingCutOut = () => hasArtwork() && imageNodes().every((n) => n.matting);
  const hasCutline = () =>
    doc().layers.some((l) => l.role === 'cutline' && l.nodes.length > 0);
  const hasHole = () => findHole(doc()) !== null;

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
        e.preventDefault();
        const a = selectedAnchor();
        if (tool() === 'node' && a) {
          removeAnchor(a);
          return;
        }
        const id = selection()[0];
        if (!id) return;
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

  /** 切るデータと印刷するデータを、まとめて 1 回で書き出す */
  async function onExport() {
    setError(null);
    try {
      const folder = await pickExportFolder();
      if (!folder) return;
      setBusy(true);
      setExported(await exportBoth(doc(), folder));
    } catch (e) {
      setError(`${t('err.exportFailed')}（${message(e)}）`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 切る線を作る。
   * できたものは普通のパスなので、そのまま点をドラッグして直せる。
   */
  function onMakeCutline() {
    // 手で直したあとなら、消えてよいか先に聞く（SPEC 7.4）
    const cut = existingCutline();
    if (cut?.origin?.type === 'cutline' && cut.origin.manuallyEdited) {
      setConfirmRemake(true);
      return;
    }
    void makeCutline();
  }

  async function makeCutline() {
    const node = targetImage();
    if (!node) return;
    // 背景を消してあればその結果から、まだなら元画像から作る
    const assetId = node.matting?.resultAssetId ?? node.assetId;
    const asset = doc().assets[assetId];
    if (!asset) return;

    setError(null);
    setCutlineBusy(true);
    try {
      const r = await generateCutline(
        asset.path,
        node.widthMm,
        node.heightMm,
        cutlineParams(),
      );
      const path: PathNode = {
        id: uid('nd'),
        type: 'path',
        name: t('cutline.title'),
        visible: true,
        locked: false,
        // 絵と同じ姿勢を持たせると、生成した座標がそのまま重なる
        transform: node.transform,
        subpaths: r.subpaths.map((sp) => ({
          closed: sp.closed,
          anchors: sp.anchors.map(
            (a): Anchor => ({
              p: { x: a.p[0], y: a.p[1] },
              in: { x: a.in[0], y: a.in[1] },
              out: { x: a.out[0], y: a.out[1] },
              kind: a.kind === 'corner' ? 'corner' : 'smooth',
            }),
          ),
        })),
        fill: null,
        stroke: { color: '#FF00FF', widthMm: 0.1, opacity: 1 },
        origin: {
          type: 'cutline',
          sourceNodeId: node.id,
          params: cutlineParams(),
          manuallyEdited: false,
        },
      };
      run(addCutline(path, existingCutlineId()));
      setCutlineIssues(r.issues);
      setCutlineSegments(r.segmentCount);
    } catch (e) {
      setError(`${t('err.cutlineFailed')}（${message(e)}）`);
    } finally {
      setCutlineBusy(false);
    }
  }

  /**
   * 道具を持ち替える。
   * 「点」に持ち替えたとき、何も選んでいなければ切る線を選んでおく。
   * 点を直したい相手はまず切る線なので、押した瞬間に点が見えるほうがよい。
   */
  function changeTool(next: ToolId) {
    setTool(next);
    setSelectedAnchor(null);
    if (next !== 'node') return;
    const sel = selection()[0];
    const found = sel ? findNode(doc(), sel) : null;
    if (found?.node.type === 'path') return;
    const cut = existingCutline();
    if (cut) selectOnly(cut.id);
  }

  /** 選んでいる点を消す。3 点を下回るなら断って理由を出す */
  function removeAnchor(a: NonNullable<ReturnType<typeof selectedAnchor>>) {
    const found = findNode(doc(), a.nodeId);
    if (!found || found.node.type !== 'path') return;
    const n = found.node;
    const next = deleteAnchor(n.subpaths, a);
    if (!next) {
      setError(t('node.tooFew'));
      return;
    }
    run(
      editSubpaths(
        n.id,
        {
          subpaths: n.subpaths,
          manuallyEdited: n.origin?.type === 'cutline' && n.origin.manuallyEdited,
        },
        next,
        'cmd.deleteAnchor',
      ),
    );
    setSelectedAnchor(null);
  }

  /**
   * キーホルダーの穴をあける。
   *
   * 置き場所は切る線の内側から自動で選ぶ。上から吊るすものなので、
   * 条件を満たすうちのいちばん上に置く（SPEC 7.6）。
   */
  function onMakeHole() {
    setError(null);
    const shape = buildHole(doc(), holePart());
    if (!shape.ok) {
      setError(t('err.holeNoRoom'));
      return;
    }
    const node = newHoleNode(shape, t('hole.title'));
    run(addHole(node, findHole(doc())?.node.id ?? null));
    selectOnly(node.id);
  }

  /**
   * 「穴」の道具で押した場所に置く。
   * 切る線があればその内側に寄せる。すでに穴があれば、それを動かす
   * （いまは穴を 1 つだけ持つ）。
   */
  function onPlaceHole(p: Point) {
    setError(null);
    const shape = buildHoleAt(doc(), holePart(), p);
    if (!shape.ok) {
      setError(t('err.holeNoRoom'));
      return;
    }
    const existing = findHole(doc());
    if (existing) {
      run(
        updateHole(
          existing.node.id,
          { transform: existing.node.transform, subpaths: existing.node.subpaths, part: existing.part },
          { transform: shape.transform, subpaths: shape.subpaths, part: shape.part },
        ),
      );
      selectOnly(existing.node.id);
    } else {
      const node = newHoleNode(shape, t('hole.title'));
      run(addHole(node, null));
      selectOnly(node.id);
    }
  }

  /** すでに切る線があれば、作り直しで置き換える */
  function existingCutline(): PathNode | null {
    const layer = doc().layers.find((l) => l.role === 'cutline');
    const n = layer?.nodes[0];
    return n?.type === 'path' ? n : null;
  }

  function existingCutlineId(): string | null {
    return existingCutline()?.id ?? null;
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
        onExport={() => void onExport()}
        onMakeCutline={onMakeCutline}
        onMakeHole={onMakeHole}
        busy={busy() || cutlineBusy()}
        hasArtwork={hasArtwork()}
        canRemoveBackground={targetImage() !== null}
        canMakeHole={hasCutline()}
      />
      <ToolRail active={tool()} onChange={changeTool} />
      <Canvas onRequestImport={() => void onImport()} onPlaceHole={onPlaceHole} />
      <Inspector />
      <StatusBar />

      <Show when={mattingProgress()}>{(p) => <ProgressOverlay progress={p()} />}</Show>

      <Show when={cutlineBusy()}>
        <div class="overlay">
          <div class="overlay-box">
            <p class="overlay-label">{t('cutline.running')}</p>
            <div class="bar">
              <div class="fill indeterminate" />
            </div>
          </div>
        </div>
      </Show>

      <Show when={exported()}>
        {(r) => <ExportDone result={r()} onClose={() => setExported(null)} />}
      </Show>

      <Show when={confirmRemake()}>
        <div class="overlay" onClick={() => setConfirmRemake(false)}>
          <div class="overlay-box" onClick={(e) => e.stopPropagation()}>
            <p class="overlay-label">{t('cutline.overwrite')}</p>
            <div style={{ display: 'flex', gap: '8px', 'justify-content': 'center', 'margin-top': '16px' }}>
              <button class="tbtn" onClick={() => setConfirmRemake(false)}>
                {t('cutline.overwriteNo')}
              </button>
              <button
                class="tbtn primary"
                onClick={() => {
                  setConfirmRemake(false);
                  setSelectedAnchor(null);
                  void makeCutline();
                }}
              >
                {t('cutline.overwriteYes')}
              </button>
            </div>
          </div>
        </div>
      </Show>

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
          {tool() === 'node'
            ? t('node.hint')
            : tool() === 'hole'
              ? t('hole.toolHint')
              : !everythingCutOut()
            ? t('next.removeBg')
            : !hasCutline()
              ? t('next.cutline')
              : !hasHole()
                ? t('next.hole')
                : t('next.export')}
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

/**
 * 書き出したあと、どちらをどの機械に持っていくかを出す（SPEC 8.4）。
 * ファイルが 2 つ出てくること自体が、初めての人には分かりにくい。
 */
function ExportDone(props: { result: ExportResult; onClose: () => void }) {
  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="overlay-box wide" onClick={(e) => e.stopPropagation()}>
        <p class="overlay-label">{t('export.done')}</p>

        <div class="handoff">
          <div class="handoff-row cut">
            <span class="file">{props.result.svgName}</span>
            <span class="to">{t('export.toLaser')}</span>
          </div>
          <div class="handoff-row print">
            <span class="file">{props.result.pdfName}</span>
            <span class="to">{t('export.toPrinter')}</span>
          </div>
        </div>

        <p class="overlay-sub folder">{props.result.folder}</p>

        <Show when={props.result.usedBoardOutline}>
          <div class="issue warn" style={{ 'margin-top': '14px', 'text-align': 'left' }}>
            <span class="mark">!</span>
            <span>{t('export.boardOutlineNote')}</span>
          </div>
        </Show>

        <button class="tbtn" style={{ 'margin-top': '16px' }} onClick={props.onClose}>
          {t('export.close')}
        </button>
      </div>
    </div>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
