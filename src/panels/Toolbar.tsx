import { For, Show } from 'solid-js';
import { t } from '~/app/i18n';
import { canRedo, canUndo, doc, redo, undo } from '~/document/store';
import { fitCanvas, zoomByStep, zoomToActualSize } from '~/canvas/viewport';
import type { ToolId } from '~/app/session';

export type { ToolId };

/** 動くのは「選択」「点」「穴」。他はまだ押せないことを見せる */
const TOOLS: { id: ToolId; glyph: string; ready: boolean }[] = [
  { id: 'select', glyph: '↖', ready: true },
  { id: 'node', glyph: '◆', ready: true },
  { id: 'path', glyph: '✎', ready: false },
  { id: 'hole', glyph: '○', ready: true },
  { id: 'stand', glyph: '⊥', ready: false },
];

export function TopBar(props: {
  onImport: () => void;
  onRemoveBackground: () => void;
  onExport: () => void;
  onMakeCutline: () => void;
  onMakeHole: () => void;
  busy: boolean;
  hasArtwork: boolean;
  canRemoveBackground: boolean;
  canMakeHole: boolean;
}) {
  return (
    <div class="topbar">
      <span class="brand">
        kakomu<i>.</i>
      </span>

      <button class="tbtn primary" onClick={props.onImport} disabled={props.busy}>
        {t('action.importImage')}
      </button>

      <button
        class="tbtn"
        onClick={props.onRemoveBackground}
        disabled={props.busy || !props.canRemoveBackground}
        title={props.canRemoveBackground ? undefined : t('matting.needImage')}
      >
        {t('action.removeBg')}
      </button>
      <button
        class="tbtn"
        onClick={props.onMakeCutline}
        disabled={props.busy || !props.canRemoveBackground}
        title={props.canRemoveBackground ? undefined : t('matting.needImage')}
      >
        {t('action.makeCutline')}
      </button>

      <button
        class="tbtn"
        onClick={props.onMakeHole}
        disabled={props.busy || !props.canMakeHole}
        title={props.canMakeHole ? undefined : t('hole.needCutline')}
      >
        {t('action.makeHole')}
      </button>

      <span style={{ width: '8px' }} />

      <button class="tbtn" onClick={undo} disabled={!canUndo()}>
        ↶ {t('action.undo')}
      </button>
      <button class="tbtn" onClick={redo} disabled={!canRedo()}>
        ↷ {t('action.redo')}
      </button>

      <span style={{ width: '8px' }} />

      <button class="tbtn" onClick={() => zoomByStep(1 / 1.25)} title={t('action.zoomOut')}>
        −
      </button>
      <button class="tbtn" onClick={() => zoomByStep(1.25)} title={t('action.zoomIn')}>
        ＋
      </button>
      <button class="tbtn" onClick={() => fitCanvas(doc().canvas)}>
        {t('action.zoomFit')}
      </button>
      <button class="tbtn" onClick={zoomToActualSize}>
        {t('action.zoomActual')}
      </button>

      <span class="spacer" />

      <Show when={props.hasArtwork}>
        <button class="tbtn" onClick={props.onExport} disabled={props.busy}>
          {t('action.export')}
        </button>
      </Show>
    </div>
  );
}

export function ToolRail(props: { active: ToolId; onChange: (id: ToolId) => void }) {
  return (
    <div class="rail">
      <For each={TOOLS}>
        {(tool) => (
          <button
            class="tool"
            aria-pressed={props.active === tool.id}
            disabled={!tool.ready}
            title={tool.ready ? undefined : 'まだ作っていません'}
            onClick={() => tool.ready && props.onChange(tool.id)}
          >
            <span class="glyph">{tool.glyph}</span>
            <span>{t(`tool.${tool.id}`)}</span>
          </button>
        )}
      </For>
    </div>
  );
}
