import { For, Show, createMemo, createSignal } from 'solid-js';
import { t } from '~/app/i18n';
import {
  doc,
  findNode,
  run,
  selection,
} from '~/document/store';
import { setImageBox, toggleLayerVisible, toggleLayerLocked, updateHole } from '~/document/commands';
import { buildHole, findHole, holeCenter, holeMargin, resizeHoleInPlace } from '~/document/parts';
import {
  compareOriginal,
  cutlineIssues,
  cutlineParams,
  cutlineSegments,
  edgeTighten,
  holePart,
  mattingModel,
  models,
  setCutlineParams,
  setHolePart,
  setCompareOriginal,
  setEdgeTighten,
  setMattingModel,
} from '~/app/session';
import type { MattingModel } from '~/app/session';
import type { HolePart, ImageNode, Layer } from '~/document/types';
import { MIN_HOLE_DIAMETER_MM, MIN_PRINT_DPI, effectiveDpi } from '~/document/types';
import * as M from '~/geometry/matrix';

export function Inspector() {
  return (
    <div class="side">
      <MattingPanel />
      <CutlinePanel />
      <HolePanel />
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
 * 刷ってから・切ってからでは直せないものを、先に出す。
 * 細すぎるところや自己交差は切る線を作るときに Rust 側が見ている。
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

  // 穴は手でも動かせるので、いまの位置で測り直す（SPEC 7.6）
  const hole = findHole(d);
  if (hole) {
    if (hole.part.diameterMm < MIN_HOLE_DIAMETER_MM) {
      issues.push({
        level: 'error',
        text: t('issue.holeTooSmall', { d: hole.part.diameterMm.toFixed(1) }),
      });
    }
    const margin = holeMargin(d, hole.node, hole.part);
    if (margin !== null) {
      if (margin < 0) {
        issues.push({ level: 'error', text: t('issue.holeOutside') });
      } else if (margin < hole.part.marginMm) {
        issues.push({
          level: 'error',
          text: t('issue.holeTooCloseToEdge', { d: margin.toFixed(1) }),
        });
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

/** 元の絵が何かで選ぶ。速さや精度では選ばせない */
const MODEL_CHOICES: { id: MattingModel; key: string }[] = [
  { id: 'isnet-general-use', key: 'matting.photo' },
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
            {(c) => {
              const info = () => models().find((m) => m.id === c.id);
              const sizeMb = () => Math.round((info()?.bytes ?? 0) / 1_048_576);
              return (
                <button
                  type="button"
                  style={{ flex: '1', 'flex-direction': 'column', gap: '2px' }}
                  aria-pressed={mattingModel() === c.id}
                  onClick={() => setMattingModel(c.id)}
                >
                  <span>{t(c.key)}</span>
                  {/* まだ手元に無いものは、押す前に大きさが分かるようにする */}
                  <Show when={info() && !info()!.downloaded}>
                    <span class="dl-size">↓ {sizeMb()}MB</span>
                  </Show>
                </button>
              );
            }}
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

// ------------------------------------------------------------------ 切る線

function CutlinePanel() {
  const [advanced, setAdvanced] = createSignal(false);
  const p = cutlineParams;
  const update = (patch: Partial<ReturnType<typeof cutlineParams>>) =>
    setCutlineParams({ ...p(), ...patch });

  return (
    <div class="panel">
      <h3>{t('cutline.title')}</h3>

      {/* 表に出すのは 2 つだけ。しきい値や最小面積が最初から並んでいてはいけない */}
      <div class="field">
        <label>
          {t('cutline.offset')} {p().offsetMm.toFixed(1)}
          {t('unit.mm')}
        </label>
        <input
          type="range"
          min="0"
          max="20"
          step="0.5"
          value={p().offsetMm}
          onInput={(e) => update({ offsetMm: Number(e.currentTarget.value) })}
          style={{ width: '100%', 'accent-color': 'var(--cut)' }}
        />
      </div>

      <div class="field" style={{ 'margin-top': '8px' }}>
        <label>
          {t('cutline.smoothing')} {Math.round(p().smoothing * 100)}%
        </label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={p().smoothing}
          onInput={(e) => update({ smoothing: Number(e.currentTarget.value) })}
          style={{ width: '100%', 'accent-color': 'var(--cut)' }}
        />
      </div>

      <button
        class="linklike"
        onClick={() => setAdvanced(!advanced())}
        aria-expanded={advanced()}
      >
        {advanced() ? '▾' : '▸'} {t('cutline.advanced')}
      </button>

      <Show when={advanced()}>
        <label class="check">
          <input
            type="checkbox"
            checked={p().enforceMinWidth}
            onChange={(e) => update({ enforceMinWidth: e.currentTarget.checked })}
          />
          {t('cutline.enforceMinWidth')}
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={p().keepHoles}
            onChange={(e) => update({ keepHoles: e.currentTarget.checked })}
          />
          {t('cutline.keepHoles')}
        </label>
        <div class="field" style={{ 'margin-top': '8px' }}>
          <label>
            {t('cutline.threshold')} {p().alphaThreshold}
          </label>
          <input
            type="range"
            min="1"
            max="254"
            step="1"
            value={p().alphaThreshold}
            onInput={(e) => update({ alphaThreshold: Number(e.currentTarget.value) })}
            style={{ width: '100%', 'accent-color': 'var(--cut)' }}
          />
        </div>
        <div class="field" style={{ 'margin-top': '8px' }}>
          <label>
            {t('cutline.minArea')} {p().minAreaMm2.toFixed(1)}
            {t('unit.mm2')}
          </label>
          <input
            type="range"
            min="0"
            max="50"
            step="0.5"
            value={p().minAreaMm2}
            onInput={(e) => update({ minAreaMm2: Number(e.currentTarget.value) })}
            style={{ width: '100%', 'accent-color': 'var(--cut)' }}
          />
        </div>
      </Show>

      <Show when={cutlineSegments() > 0}>
        <p class="empty-note" style={{ 'margin-top': '10px', 'font-size': '11px' }}>
          {t('cutline.segments', { n: cutlineSegments() })} ／ {t('cutline.editable')}
        </p>
      </Show>

      <For each={cutlineIssues()}>
        {(issue) => (
          <div class={`issue ${issue.severity}`} style={{ 'margin-top': '10px' }}>
            <span class="mark">{issue.severity === 'error' ? '×' : '!'}</span>
            <span>{t(`issue.${issue.kind}`, { d: issue.detail ?? '' })}</span>
          </div>
        )}
      </For>
    </div>
  );
}

// ------------------------------------------------------------------ 穴

/**
 * キーホルダーの穴。
 *
 * 値を変えたらその場で作り直す（SPEC 7.6）。すでに置いてある場所が
 * 条件を満たしているうちは動かさない。手で置き直した穴が、
 * 大きさを少し変えただけで飛んでいっては困るため。
 */
function HolePanel() {
  const hole = createMemo(() => findHole(doc()));

  function change(patch: Partial<HolePart>) {
    const next: HolePart = { ...holePart(), ...patch };
    setHolePart(next);

    const found = hole();
    if (!found) return;
    const before = {
      transform: found.node.transform,
      subpaths: found.node.subpaths,
      part: found.part,
    };
    const shape = buildHole(doc(), next, holeCenter(found.node));
    const after = shape.ok ? shape : resizeHoleInPlace(found.node, next);
    run(
      updateHole(
        found.node.id,
        before,
        { transform: after.transform, subpaths: after.subpaths, part: after.part },
        `hole:${found.node.id}`,
      ),
    );
  }

  function replace() {
    const found = hole();
    if (!found) return;
    const shape = buildHole(doc(), holePart());
    if (!shape.ok) return;
    run(
      updateHole(
        found.node.id,
        { transform: found.node.transform, subpaths: found.node.subpaths, part: found.part },
        { transform: shape.transform, subpaths: shape.subpaths, part: shape.part },
      ),
    );
  }

  const p = () => hole()?.part ?? holePart();

  return (
    <div class="panel">
      <h3>{t('hole.title')}</h3>

      <div class="field">
        <label>
          {t('hole.diameter')} φ{p().diameterMm.toFixed(1)}
          {t('unit.mm')}
        </label>
        <input
          type="range"
          min="2"
          max="10"
          step="0.5"
          value={p().diameterMm}
          onInput={(e) => change({ diameterMm: Number(e.currentTarget.value) })}
          style={{ width: '100%', 'accent-color': 'var(--cut)' }}
        />
      </div>

      <div class="field" style={{ 'margin-top': '8px' }}>
        <label>
          {t('hole.margin')} {p().marginMm.toFixed(1)}
          {t('unit.mm')}
        </label>
        <input
          type="range"
          min="1"
          max="10"
          step="0.5"
          value={p().marginMm}
          onInput={(e) => change({ marginMm: Number(e.currentTarget.value) })}
          style={{ width: '100%', 'accent-color': 'var(--cut)' }}
        />
      </div>

      <Show
        when={hole()}
        fallback={
          <p class="empty-note" style={{ 'margin-top': '10px', 'font-size': '11px' }}>
            {t('hole.none')}
          </p>
        }
      >
        <button class="linklike" onClick={replace}>
          {t('hole.place')}
        </button>
        <p class="empty-note" style={{ 'margin-top': '6px', 'font-size': '11px' }}>
          {t('hole.placed')}
        </p>
      </Show>
    </div>
  );
}
