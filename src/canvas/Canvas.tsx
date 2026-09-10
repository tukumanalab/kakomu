/**
 * キャンバス。v1 は SVG DOM で描く（SPEC 5.1）。
 * viewBox の 1 単位 = 1mm なので、描画コードに px が出てこない。
 */

import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { ImageNode, Layer, Node, PathNode, Point } from '~/document/types';
import { subpathsToPathData } from '~/geometry/path';
import { displayAssetId, doc, findNode, isSelected, run, selectOnly, selection } from '~/document/store';
import { compareOriginal } from '~/app/session';
import { setImageBox, setTransform } from '~/document/commands';
import * as M from '~/geometry/matrix';
import { fitCanvas, panBy, screenToMm, setSize, toMm, viewBox, zoomAt } from './viewport';

type Corner = 0 | 1 | 2 | 3; // TL, TR, BR, BL

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'move'; id: string; start: Point; before: M.Matrix }
  | {
      kind: 'resize';
      id: string;
      corner: Corner;
      before: { transform: M.Matrix; widthMm: number; heightMm: number };
    }
  | { kind: 'rotate'; id: string; before: M.Matrix; centerWorld: Point };

export default function Canvas(props: { onRequestImport: () => void }) {
  let host!: HTMLDivElement;
  let svg!: SVGSVGElement;

  const [drag, setDrag] = createSignal<Drag>({ kind: 'none' });
  const [spaceHeld, setSpaceHeld] = createSignal(false);

  const d = doc;

  onMount(() => {
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const r = entry.contentRect;
      setSize({ width: r.width, height: r.height });
    });
    ro.observe(host);
    // 最初の一回はレイアウト確定後に合わせる
    queueMicrotask(() => {
      const r = host.getBoundingClientRect();
      setSize({ width: r.width, height: r.height });
      fitCanvas(d().canvas);
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) setSpaceHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    });
  });

  function localPoint(e: PointerEvent | WheelEvent): { px: number; py: number } {
    const r = svg.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  }

  function mmPoint(e: PointerEvent): Point {
    const { px, py } = localPoint(e);
    return toMm(px, py);
  }

  // ------------------------------------------------------------- 入力

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const { px, py } = localPoint(e);
    if (e.ctrlKey || e.metaKey) {
      zoomAt(px, py, Math.exp(-e.deltaY * 0.01));
    } else {
      panBy(-e.deltaX, -e.deltaY);
    }
  }

  function onPointerDown(e: PointerEvent) {
    svg.setPointerCapture(e.pointerId);

    // 中ボタン、または Space + ドラッグでパン
    if (e.button === 1 || spaceHeld()) {
      setDrag({ kind: 'pan', lastX: e.clientX, lastY: e.clientY });
      return;
    }
    if (e.button !== 0) return;

    const target = e.target as Element;
    const handle = target.closest('[data-handle]');
    const selId = selection()[0];

    if (handle && selId) {
      const kind = handle.getAttribute('data-handle');
      const found = findNode(d(), selId);
      if (found && found.node.type === 'image') {
        const n = found.node;
        if (kind === 'rotate') {
          setDrag({
            kind: 'rotate',
            id: selId,
            before: n.transform,
            centerWorld: M.apply(n.transform, { x: n.widthMm / 2, y: n.heightMm / 2 }),
          });
        } else {
          setDrag({
            kind: 'resize',
            id: selId,
            corner: Number(kind) as Corner,
            before: { transform: n.transform, widthMm: n.widthMm, heightMm: n.heightMm },
          });
        }
        return;
      }
    }

    const hit = target.closest('[data-node]');
    const id = hit?.getAttribute('data-node') ?? null;
    selectOnly(id);
    if (id) {
      const found = findNode(d(), id);
      if (found) setDrag({ kind: 'move', id, start: mmPoint(e), before: found.node.transform });
    }
  }

  function onPointerMove(e: PointerEvent) {
    const st = drag();
    switch (st.kind) {
      case 'none':
        return;

      case 'pan': {
        panBy(e.clientX - st.lastX, e.clientY - st.lastY);
        setDrag({ kind: 'pan', lastX: e.clientX, lastY: e.clientY });
        return;
      }

      case 'move': {
        const p = mmPoint(e);
        let dx = p.x - st.start.x;
        let dy = p.y - st.start.y;
        if (e.shiftKey) {
          // 軸を固定する
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const b = st.before;
        const next: M.Matrix = [b[0], b[1], b[2], b[3], b[4] + dx, b[5] + dy];
        run(setTransform(st.id, b, next, 'cmd.move', `move:${st.id}`));
        return;
      }

      case 'resize': {
        const p = mmPoint(e);
        const b = st.before;
        // ローカル座標に持ち込むと、回転していても素直に計算できる
        const local = M.apply(M.invert(b.transform), p);
        const anchor = cornerLocal(oppositeCorner(st.corner), b.widthMm, b.heightMm);

        let w = Math.abs(local.x - anchor.x);
        let h = Math.abs(local.y - anchor.y);
        if (e.shiftKey) {
          // たてよこの比を保つ
          const ratio = b.widthMm / b.heightMm;
          if (w / h > ratio) h = w / ratio;
          else w = h * ratio;
        }
        const MIN = 1; // 1mm 未満には潰さない
        w = Math.max(MIN, w);
        h = Math.max(MIN, h);

        // つかんだ角の反対側を固定する
        const originLocal: Point = {
          x: st.corner === 1 || st.corner === 2 ? anchor.x : anchor.x - w,
          y: st.corner === 2 || st.corner === 3 ? anchor.y : anchor.y - h,
        };
        const next = translateLocal(b.transform, originLocal);
        run(
          setImageBox(
            st.id,
            b,
            { transform: next, widthMm: w, heightMm: h },
            `resize:${st.id}`,
          ),
        );
        return;
      }

      case 'rotate': {
        const found = findNode(d(), st.id);
        if (!found || found.node.type !== 'image') return;
        const n = found.node;
        const p = mmPoint(e);
        let deg =
          (Math.atan2(p.y - st.centerWorld.y, p.x - st.centerWorld.x) * 180) / Math.PI + 90;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;

        const r = (deg * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        const hx = -n.widthMm / 2;
        const hy = -n.heightMm / 2;
        const next: M.Matrix = [
          cos,
          sin,
          -sin,
          cos,
          st.centerWorld.x + (cos * hx - sin * hy),
          st.centerWorld.y + (sin * hx + cos * hy),
        ];
        run(setTransform(st.id, st.before, next, 'cmd.rotate', `rotate:${st.id}`));
        return;
      }
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    setDrag({ kind: 'none' });
  }

  // ------------------------------------------------------------- 描画

  const canvas = createMemo(() => d().canvas);
  const bleed = createMemo(() => canvas().bleedMm);

  /** ハンドルは画面上でいつも同じ大きさに見せる */
  const handleMm = createMemo(() => screenToMm(9));
  const hairline = createMemo(() => screenToMm(1));

  const selectedImage = createMemo<ImageNode | null>(() => {
    const id = selection()[0];
    if (!id) return null;
    const found = findNode(d(), id);
    return found && found.node.type === 'image' ? found.node : null;
  });

  const isEmpty = createMemo(() => d().layers.every((l) => l.nodes.length === 0));

  return (
    <div
      class="canvas-wrap"
      classList={{ panning: drag().kind === 'pan' || spaceHeld() }}
      ref={host}
    >
      <svg
        ref={svg}
        viewBox={viewBox()}
        preserveAspectRatio="xMinYMin slice"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* 塗り足しの外側 */}
        <rect
          x={-bleed()}
          y={-bleed()}
          width={canvas().widthMm + bleed() * 2}
          height={canvas().heightMm + bleed() * 2}
          fill="var(--surface)"
        />
        {/* しあがりの枠（実線）と、ふちの余白（破線） */}
        <rect
          x={-bleed()}
          y={-bleed()}
          width={canvas().widthMm + bleed() * 2}
          height={canvas().heightMm + bleed() * 2}
          fill="none"
          stroke="var(--line)"
          stroke-width={hairline()}
          stroke-dasharray={`${handleMm() * 0.5} ${handleMm() * 0.4}`}
        />
        <rect
          x={0}
          y={0}
          width={canvas().widthMm}
          height={canvas().heightMm}
          fill="none"
          stroke="var(--muted)"
          stroke-width={hairline()}
        />

        <For each={d().layers}>
          {(layer: Layer) => (
            <Show when={layer.visible}>
              <g opacity={layer.opacity} data-layer={layer.role}>
                <For each={layer.nodes}>{(node: Node) => <NodeView node={node} />}</For>
              </g>
            </Show>
          )}
        </For>

        {/* 選択枠とハンドル */}
        <Show when={selectedImage()}>
          {(n) => (
            <SelectionFrame
              node={n()}
              handleMm={handleMm()}
              hairline={hairline()}
            />
          )}
        </Show>
      </svg>

      <Show when={isEmpty()}>
        <EmptyState onPick={props.onRequestImport} />
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------ ノード

function NodeView(props: { node: Node }) {
  const d = doc;
  return (
    <Show when={props.node.visible}>
      <Show when={props.node.type === 'path'}>
        {(() => {
          const n = props.node as PathNode;
          // 線幅は 0.1mm しかないので、そのままだと画面で見えない。
          // 実寸は書き出しのときの値を使い、画面では見える太さで描く
          const shown = () => Math.max(n.stroke?.widthMm ?? 0.1, screenToMm(1.6));
          // 部品（穴）は中もつかめるようにする。φ4mm の円は画面で 10px ほどしか
          // なく、線そのものをつまませるのは子どもには無理がある。
          // 見た目は透明なので変わらず、書き出しは常に fill="none"（SPEC 8.1）
          const grabbable = () => n.origin?.type === 'part';
          return (
            <path
              data-node={n.id}
              d={subpathsToPathData(n.subpaths)}
              transform={M.toSvg(n.transform)}
              fill={grabbable() ? 'transparent' : 'none'}
              stroke={n.stroke?.color ?? 'var(--cut)'}
              stroke-width={shown()}
              vector-effect="none"
              style={{ cursor: isSelected(n.id) ? 'move' : 'pointer' }}
            />
          );
        })()}
      </Show>
      <Show when={props.node.type === 'image'}>
        {(() => {
          const n = props.node as ImageNode;
          const asset = () => {
            const id = displayAssetId(n, compareOriginal());
            return id ? d().assets[id] : undefined;
          };
          return (
            <Show when={asset()}>
              {(a) => (
                <image
                  data-node={n.id}
                  href={a().url}
                  x={0}
                  y={0}
                  width={n.widthMm}
                  height={n.heightMm}
                  transform={M.toSvg(n.transform)}
                  preserveAspectRatio="none"
                  style={{ cursor: isSelected(n.id) ? 'move' : 'pointer' }}
                />
              )}
            </Show>
          );
        })()}
      </Show>
    </Show>
  );
}

// ------------------------------------------------------------------ 選択枠

function SelectionFrame(props: { node: ImageNode; handleMm: number; hairline: number }) {
  const pts = createMemo(() =>
    M.corners(props.node.transform, props.node.widthMm, props.node.heightMm),
  );
  const half = () => props.handleMm / 2;

  /** 回転ハンドルは上辺の中央から外に離す */
  const rotatePos = createMemo(() => {
    const p = pts();
    const tl = p[0]!;
    const tr = p[1]!;
    const bl = p[3]!;
    const midX = (tl.x + tr.x) / 2;
    const midY = (tl.y + tr.y) / 2;
    // 上辺から外向きの単位ベクトル
    const ux = tl.x - bl.x;
    const uy = tl.y - bl.y;
    const len = Math.hypot(ux, uy) || 1;
    const off = props.handleMm * 2.4;
    return { x: midX + (ux / len) * off, y: midY + (uy / len) * off, midX, midY };
  });

  return (
    <g pointer-events="none">
      <polygon
        points={pts().map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="var(--cut)"
        stroke-width={props.hairline}
      />
      <line
        x1={rotatePos().midX}
        y1={rotatePos().midY}
        x2={rotatePos().x}
        y2={rotatePos().y}
        stroke="var(--cut)"
        stroke-width={props.hairline}
      />
      <circle
        data-handle="rotate"
        cx={rotatePos().x}
        cy={rotatePos().y}
        r={half()}
        fill="var(--surface)"
        stroke="var(--cut)"
        stroke-width={props.hairline * 1.5}
        pointer-events="all"
        style={{ cursor: 'grab' }}
      />
      <For each={pts()}>
        {(p, i) => (
          <rect
            data-handle={String(i())}
            x={p.x - half()}
            y={p.y - half()}
            width={props.handleMm}
            height={props.handleMm}
            fill="var(--surface)"
            stroke="var(--cut)"
            stroke-width={props.hairline * 1.5}
            pointer-events="all"
            style={{ cursor: i() % 2 === 0 ? 'nwse-resize' : 'nesw-resize' }}
          />
        )}
      </For>
    </g>
  );
}

// ------------------------------------------------------------------ 空の状態

import { t } from '~/app/i18n';

function EmptyState(props: { onPick: () => void }) {
  return (
    <div class="empty">
      <div class="box">
        <h2>{t('empty.title')}</h2>
        <p>{t('empty.drop')}</p>
        <button class="big" onClick={props.onPick}>
          {t('empty.button')}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 補助

function cornerLocal(c: Corner, w: number, h: number): Point {
  switch (c) {
    case 0:
      return { x: 0, y: 0 };
    case 1:
      return { x: w, y: 0 };
    case 2:
      return { x: w, y: h };
    case 3:
      return { x: 0, y: h };
  }
}

function oppositeCorner(c: Corner): Corner {
  return ((c + 2) % 4) as Corner;
}

/** 「平行移動 × 回転」の形を保ったまま、ローカル座標ぶんだけ原点をずらす */
function translateLocal(m: M.Matrix, local: Point): M.Matrix {
  const [a, b, c, dd, e, f] = m;
  return [a, b, c, dd, e + a * local.x + c * local.y, f + b * local.x + dd * local.y];
}
