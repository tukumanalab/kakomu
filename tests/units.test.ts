import { describe, expect, it } from 'vitest';
import { effectiveDpi, mmToPx, pxToMm } from '../src/document/types';

describe('単位', () => {
  it('300dpi の 300px は 1 インチ = 25.4mm', () => {
    expect(pxToMm(300, 300)).toBeCloseTo(25.4, 9);
  });

  it('mm と px の往復で値が変わらない', () => {
    expect(mmToPx(pxToMm(1234, 350), 350)).toBeCloseTo(1234, 9);
  });

  it('実効解像度は配置サイズで決まる', () => {
    // 2000px の画像を 100mm 幅で置くと約 508dpi
    expect(effectiveDpi(2000, 100)).toBeCloseTo(508, 0);
  });
});
