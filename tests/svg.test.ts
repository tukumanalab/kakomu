/**
 * 切るデータ（SVG）の検査。
 *
 * ここがずれると、加工機で実寸が変わったり、切るはずの線が
 * 彫刻になったりする。刷ってから気づいても直せないので、
 * SPEC 8.1 の決め事をそのままテストにしておく。
 */
import { describe, expect, it } from 'vitest';
import { buildCutlineSvg } from '../src/app/../export/svg';
import { circleSubPath } from '../src/geometry/hole';
import type { Doc, PathNode } from '../src/document/types';

function emptyDoc(): Doc {
  return {
    version: 2,
    id: 'doc',
    meta: { title: '', created: '', modified: '' },
    canvas: { widthMm: 80, heightMm: 120, bleedMm: 3 },
    assets: {},
    layers: [
      { id: 'a', nameKey: 'layer.artwork', role: 'artwork', visible: true, locked: false, opacity: 1, nodes: [] },
      { id: 'c', nameKey: 'layer.cutline', role: 'cutline', visible: true, locked: false, opacity: 1, nodes: [] },
      { id: 'p', nameKey: 'layer.parts', role: 'parts', visible: true, locked: false, opacity: 1, nodes: [] },
    ],
    product: { kind: 'acrylic-keychain', thicknessMm: 3, defaultOffsetMm: 3 },
  };
}

/** 原点から (10,0)(10,10)(0,10) を通る四角。ハンドルは 0（直線） */
function squarePath(transform: PathNode['transform']): PathNode {
  const corner = (x: number, y: number) => ({
    p: { x, y },
    in: { x: 0, y: 0 },
    out: { x: 0, y: 0 },
    kind: 'corner' as const,
  });
  return {
    id: 'n1',
    type: 'path',
    name: '',
    visible: true,
    locked: false,
    transform,
    subpaths: [
      {
        closed: true,
        anchors: [corner(0, 0), corner(10, 0), corner(10, 10), corner(0, 10)],
      },
    ],
    fill: null,
    stroke: null,
  };
}

/** 部品のレイヤーに入るキーホルダーの穴 */
function holePath(cx: number, cy: number, diameterMm: number): PathNode {
  return {
    id: 'h1',
    type: 'path',
    name: '穴',
    visible: true,
    locked: false,
    transform: [1, 0, 0, 1, cx, cy],
    subpaths: [circleSubPath(diameterMm / 2)],
    fill: null,
    stroke: { color: '#FF00FF', widthMm: 0.1, opacity: 1 },
    origin: { type: 'part', part: { kind: 'hole', diameterMm, marginMm: 3 } },
  };
}

describe('切るデータ（SVG）', () => {
  it('実寸が保たれる（1 単位 = 1mm）', () => {
    const { svg } = buildCutlineSvg(emptyDoc());
    expect(svg).toContain('width="80mm"');
    expect(svg).toContain('height="120mm"');
    expect(svg).toContain('viewBox="0 0 80 120"');
  });

  it('塗りがない（XCS で彫刻扱いにならない）', () => {
    const { svg } = buildCutlineSvg(emptyDoc());
    expect(svg).toContain('fill="none"');
    expect(svg).not.toMatch(/fill="(?!none)/);
  });

  it('色と線幅が加工機向けになっている', () => {
    const { svg } = buildCutlineSvg(emptyDoc());
    expect(svg).toContain('stroke="#FF00FF"');
    expect(svg).toContain('stroke-width="0.1"');
  });

  it('レイヤー名が CutContour', () => {
    const { svg } = buildCutlineSvg(emptyDoc());
    expect(svg).toContain('inkscape:label="CutContour"');
  });

  it('切る線がまだ無いときは板の外形を仮に出す', () => {
    const { usedBoardOutline, svg } = buildCutlineSvg(emptyDoc());
    expect(usedBoardOutline).toBe(true);
    expect(svg).toContain('<path');
  });

  it('切る線があれば板の外形は出さない', () => {
    const doc = emptyDoc();
    doc.layers[1]!.nodes = [squarePath([1, 0, 0, 1, 0, 0])];
    const { usedBoardOutline } = buildCutlineSvg(doc);
    expect(usedBoardOutline).toBe(false);
  });

  it('円弧を使わず三次ベジェだけで書く', () => {
    const doc = emptyDoc();
    doc.layers[1]!.nodes = [squarePath([1, 0, 0, 1, 0, 0])];
    const { svg } = buildCutlineSvg(doc);
    const d = svg.match(/ d="([^"]+)"/)![1]!;
    // 使ってよいのは M / C / L / Z だけ。A（円弧）や Q は出さない
    expect(d).not.toMatch(/[AaQqSsTt]/);
    expect(d).toMatch(/^M /);
  });

  it('transform をベイクして絶対座標にする', () => {
    const doc = emptyDoc();
    // 25mm 右、40mm 下にずらす
    doc.layers[1]!.nodes = [squarePath([1, 0, 0, 1, 25, 40])];
    const { svg } = buildCutlineSvg(doc);
    expect(svg).not.toContain('transform=');
    const d = svg.match(/ d="([^"]+)"/)![1]!;
    expect(d.startsWith('M 25 40')).toBe(true);
    expect(d).toContain('35 40'); // (10,0) がずれた先
  });

  it('部品の穴も、切る線と同じ群・同じ色で出る', () => {
    // 加工機は色で加工を振り分ける。穴だけ別扱いになってはいけない（SPEC 7.6）
    const doc = emptyDoc();
    doc.layers[1]!.nodes = [squarePath([1, 0, 0, 1, 0, 0])];
    doc.layers[2]!.nodes = [holePath(20, 10, 4)];
    const { svg, usedBoardOutline } = buildCutlineSvg(doc);

    expect(usedBoardOutline).toBe(false);
    const paths = svg.match(/<path /g)!;
    expect(paths).toHaveLength(2);
    // 群はひとつ
    expect(svg.match(/<g /g)).toHaveLength(1);
    expect(svg.match(/stroke="#FF00FF"/g)).toHaveLength(2);
    // 穴は絶対座標にベイクされる。中心 (20,10) の右端が (22,10)
    expect(svg).toContain('M 22 10');
  });

  it('回転していても絶対座標になる', () => {
    const doc = emptyDoc();
    // 90 度回転（cos0 sin1 -sin1 cos0）して (50, 10) へ
    doc.layers[1]!.nodes = [squarePath([0, 1, -1, 0, 50, 10])];
    const { svg } = buildCutlineSvg(doc);
    const d = svg.match(/ d="([^"]+)"/)![1]!;
    expect(d.startsWith('M 50 10')).toBe(true);
    // ローカル (10,0) は回転して (50, 20) に来る
    expect(d).toContain('50 20');
  });
});
