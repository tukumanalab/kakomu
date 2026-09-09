import { For, Show } from 'solid-js';
import { readingLevel, setReadingLevel, t } from '~/app/i18n';
import type { ReadingLevel } from '~/app/i18n';
import { canRedo, canUndo, doc, redo, undo } from '~/document/store';
import { fitCanvas, zoomByStep, zoomToActualSize } from '~/canvas/viewport';

export type ToolId = 'select' | 'node' | 'path' | 'hole' | 'stand';

/** M0 で実際に動くのは「えらぶ」だけ。他はまだ押せないことを見せる */
const TOOLS: { id: ToolId; glyph: string; ready: boolean }[] = [
  { id: 'select', glyph: '↖', ready: true },
  { id: 'node', glyph: '◆', ready: false },
  { id: 'path', glyph: '✎', ready: false },
  { id: 'hole', glyph: '○', ready: false },
  { id: 'stand', glyph: '⊥', ready: false },
];

export function TopBar(props: {
  onImport: () => void;
  onRemoveBackground: () => void;
  busy: boolean;
  hasArtwork: boolean;
  canRemoveBackground: boolean;
}) {
  const levels: { id: ReadingLevel; key: string }[] = [
    { id: 'kanji', key: 'read.kanji' },
    { id: 'hira', key: 'read.hira' },
  ];

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
      {/* 囲む は M4。押せないことを隠さない */}
      <button class="tbtn" disabled title="M4 でつくります">
        {t('action.makeCutline')}
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
        <button class="tbtn" disabled title="M1 でつくります">
          {t('action.export')}
        </button>
      </Show>

      <div class="reader">
        <span class="reader-label">{t('read.label')}</span>
        <div class="seg" role="group" aria-label={t('read.label')}>
          <For each={levels}>
            {(l) => (
              <button
                type="button"
                aria-pressed={readingLevel() === l.id}
                onClick={() => setReadingLevel(l.id)}
              >
                {t(l.key)}
              </button>
            )}
          </For>
        </div>
      </div>
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
