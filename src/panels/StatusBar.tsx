import { Show, createMemo } from 'solid-js';
import { t } from '~/app/i18n';
import { doc, findNode, selection } from '~/document/store';
import { MIN_PRINT_DPI, effectiveDpi } from '~/document/types';
import { zoomPercent } from '~/canvas/viewport';
import { collectIssues } from './Inspector';

export function StatusBar() {
  const dpi = createMemo<number | null>(() => {
    const id = selection()[0];
    if (!id) return null;
    const found = findNode(doc(), id);
    if (!found || found.node.type !== 'image') return null;
    const asset = doc().assets[found.node.assetId];
    if (!asset) return null;
    return effectiveDpi(asset.widthPx, found.node.widthMm);
  });

  const issues = createMemo(collectIssues);

  return (
    <div class="status">
      <span class="k">{t('canvas.size')}</span>
      <span class="v">
        {doc().canvas.widthMm} × {doc().canvas.heightMm} {t('unit.mm')}
      </span>

      <span class="k">{t('status.zoom')}</span>
      <span class="v">{zoomPercent()}%</span>

      <Show when={dpi() !== null}>
        <span class="k">{t('status.dpi')}</span>
        <span class="v" classList={{ warn: dpi()! < MIN_PRINT_DPI }}>
          {Math.round(dpi()!)} dpi
        </span>
      </Show>

      <span class="spacer" style={{ flex: 1 }} />

      <Show when={issues().length > 0} fallback={<span class="v">{t('status.ready')}</span>}>
        <span class="k">{t('status.warnings')}</span>
        <span class="v warn">{issues().length}</span>
      </Show>
    </div>
  );
}
