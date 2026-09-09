import { For, Show, createMemo, createSignal } from 'solid-js';
import { t } from '~/app/i18n';
import {
  doc,
  findNode,
  run,
  selection,
} from '~/document/store';
import { setImageBox, toggleLayerVisible, toggleLayerLocked } from '~/document/commands';
import {
  compareOriginal,
  edgeTighten,
  mattingModel,
  setCompareOriginal,
  setEdgeTighten,
  setMattingModel,
} from '~/app/session';
import type { MattingModel } from '~/app/session';
import type { ImageNode, Layer } from '~/document/types';
import { MIN_PRINT_DPI, effectiveDpi } from '~/document/types';
import * as M from '~/geometry/matrix';

export function Inspector() {
  return (
    <div class="side">
      <MattingPanel />
      <PropertiesPanel />
      <LayersPanel />
      <ChecksPanel />
    </div>
  );
}

// ------------------------------------------------------------------ せってい

function PropertiesPanel() {
  const [keepRatio, setKeepRatio] = createSignal(true);

  const node = createMemo<ImageNode | null>(() => {
    const id = selection()[0];
    if (!id) return null;
    const found = findNode(doc(), id);
    return found && found.node.type === 'image' ? found.node : null;
  });

  const pose = createMemo(() => {
    const n = node();
    return n ? M.decompose(n.transform) : null;
  });

  function commit(next: { x?: number; y?: number; w?: number; h?: number; deg?: number }) {
    const n = node();
    const p = pose();
    if (!n || !p) return;
    const before = { transform: n.transform, widthMm: n.widthMm, heightMm: n.heightMm };

    let w = next.w ?? n.widthMm;
    let h = next.h ?? n.heightMm;
    if (keepRatio()) {
      const ratio = n.widthMm / n.heightMm;
      if (next.w !== undefined) h = w / ratio;
      else if (next.h !== undefined) w = h * ratio;
    }
    w = Math.max(1, w);
    h = Math.max(1, h);

    const transform = M.compose(next.x ?? p.x, next.y ?? p.y, next.deg ?? p.rotationDeg);
    run(setImageBox(n.id, before, { transform, widthMm: w, heightMm: h }));
  }

  return (
    <div class="panel">
      <h3>{t('panel.properties')}</h3>
      <Show
        when={node()}
        fallback={<p class="empty-note">{t('prop.nothingSelected')}</p>}
      >
        {(n) => (
          <>
            <div class="fields">
              <NumField
                label={t('prop.x')}
                unit={t('unit.mm')}
                value={pose()!.x}
                onCommit={(v) => commit({ x: v })}
              />
              <NumField
                label={t('prop.y')}
                unit={t('unit.mm')}
                value={pose()!.y}
                onCommit={(v) => commit({ y: v })}
              />
              <NumField
                label={t('prop.width')}
                unit={t('unit.mm')}
                value={n().widthMm}
                onCommit={(v) => commit({ w: v })}
              />
              <NumField
                label={t('prop.height')}
                unit={t('unit.mm')}
                value={n().heightMm}
                onCommit={(v) => commit({ h: v })}
              />
              <NumField
                label={t('prop.angle')}
                unit={t('unit.deg')}
                value={pose()!.rotationDeg}
                onCommit={(v) => commit({ deg: v })}
              />
            </div>
            <label class="check">
              <input
                type="checkbox"
                checked={keepRatio()}
                onChange={(e) => setKeepRatio(e.currentTarget.checked)}
              />
              {t('prop.keepRatio')}
            </label>
          </>
        )}
      </Show>
    </div>
  );
}

/** 数値入力。表示は常に mm か度で、px は出さない */
function NumField(props: {
  label: string;
  unit: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [editing, setEditing] = createSignal<string | null>(null);
  const shown = () => editing() ?? props.value.toFixed(1);

  function commit(raw: string) {
    const v = Number.parseFloat(raw);
    setEditing(null);
    if (Number.isFinite(v)) props.onCommit(v);
  }

  return (
    <div class="field">
      <label>{props.label}</label>
      <div class="input">
        <input
          type="text"
          inputmode="decimal"
          value={shown()}
          onInput={(e) => setEditing(e.currentTarget.value)}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setEditing(null);
              e.currentTarget.blur();
            }
          }}
        />
        <span class="unit">{props.unit}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ かさね

function LayersPanel() {
  return (
    <div class="panel">
      <h3>{t('panel.layers')}</h3>
      {/* 上に描かれるものを上に並べる */}
      <For each={[...doc().layers].reverse()}>
        {(layer: Layer) => (
          <div class="layer">
            <span class={`role ${layer.role}`} />
            <span class="name">{t(layer.nameKey)}</span>
            <span class="count">{layer.nodes.length}</span>
            <button
              class="icon-btn"
              classList={{ off: !layer.visible }}
              title={t('cmd.toggleVisible')}
              onClick={() => run(toggleLayerVisible(layer.id, !layer.visible))}
            >
              {layer.visible ? '◉' : '○'}
            </button>
            <button
              class="icon-btn"
              classList={{ off: !layer.locked }}
              onClick={() => run(toggleLayerLocked(layer.id, !layer.locked))}
            >
              {layer.locked ? '🔒' : '🔓'}
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

// ------------------------------------------------------------------ チェック

export interface Issue {
  level: 'warn' | 'error';
  text: string;
}

/**
 * M0 で本当に判定できるのは実効解像度だけ。
 * 最小幅や自己交差は切る線ができてから（M4）。
 */
export function collectIssues(): Issue[] {
  const d = doc();
  const issues: Issue[] = [];
  for (const layer of d.layers) {
    for (const node of layer.nodes) {
      if (node.type !== 'image') continue;
      const asset = d.assets[node.assetId];
      if (!asset) continue;
      const dpi = effectiveDpi(asset.widthPx, node.widthMm);
      if (dpi < MIN_PRINT_DPI) {
        issues.push({ level: 'warn', text: t('warn.lowDpi') });
      }
    }
  }
  return issues;
}

function ChecksPanel() {
  const issues = createMemo(collectIssues);
  return (
    <div class="panel">
      <h3>{t('panel.checks')}</h3>
      <Show
        when={issues().length > 0}
        fallback={<p class="ok-note">{t('status.ready')}</p>}
      >
        <For each={issues()}>
          {(issue) => (
            <div class={`issue ${issue.level}`}>
              <span class="mark">{issue.level === 'error' ? '×' : '!'}</span>
              <span>{issue.text}</span>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------ 背景を消す

const MODEL_CHOICES: { id: MattingModel; key: string }[] = [
  { id: 'u2netp', key: 'matting.fast' },
  { id: 'isnet-general-use', key: 'matting.nice' },
  { id: 'isnet-anime', key: 'matting.illust' },
];

function MattingPanel() {
  const target = createMemo<ImageNode | null>(() => {
    const id = selection()[0];
    if (!id) return null;
    const found = findNode(doc(), id);
    return found && found.node.type === 'image' ? found.node : null;
  });

  return (
    <div class="panel">
      <h3>{t('matting.title')}</h3>

      <div class="field" style={{ 'margin-bottom': '10px' }}>
        <label>{t('matting.model')}</label>
        <div class="seg" style={{ width: '100%' }}>
          <For each={MODEL_CHOICES}>
            {(c) => (
              <button
                type="button"
                style={{ flex: '1' }}
                aria-pressed={mattingModel() === c.id}
                onClick={() => setMattingModel(c.id)}
              >
                {t(c.key)}
              </button>
            )}
          </For>
        </div>
      </div>
      <p class="empty-note" style={{ 'font-size': '11px' }}>
        {t('matting.modelNote')}
      </p>

      <div class="field" style={{ 'margin-top': '10px' }}>
        <label>
          {t('matting.edge')} {Math.round(edgeTighten() * 100)}%
        </label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={edgeTighten()}
          onInput={(e) => setEdgeTighten(Number(e.currentTarget.value))}
          style={{ width: '100%', 'accent-color': 'var(--cut)' }}
        />
      </div>

      <Show when={target()?.matting}>
        <label class="check">
          <input
            type="checkbox"
            checked={compareOriginal()}
            onChange={(e) => setCompareOriginal(e.currentTarget.checked)}
          />
          {t('matting.compare')}
        </label>
        <div class="issue warn" style={{ 'margin-top': '10px' }}>
          <span class="mark">!</span>
          <span>{t('matting.check')}</span>
        </div>
      </Show>
    </div>
  );
}
