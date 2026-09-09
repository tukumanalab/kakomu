/**
 * 読みやすさの 2 段階が食い違っていないかを CI で落とす（SPEC 14）。
 * ひらがなは人が書き下ろすので、キーの取りこぼしが起きやすい。
 */
import { describe, expect, it } from 'vitest';
import ja from '../src/app/i18n/ja.json';
import hira from '../src/app/i18n/ja-hira.json';

const kanjiKeys = Object.keys(ja as Record<string, string>).sort();
const hiraKeys = Object.keys(hira as Record<string, string>).sort();

describe('i18n', () => {
  it('ひらがな側に足りないキーがない', () => {
    expect(kanjiKeys.filter((k) => !hiraKeys.includes(k))).toEqual([]);
  });

  it('ひらがな側に余分なキーがない', () => {
    expect(hiraKeys.filter((k) => !kanjiKeys.includes(k))).toEqual([]);
  });

  it('空文字の値がない', () => {
    const all = { ...(ja as Record<string, string>), ...(hira as Record<string, string>) };
    expect(Object.entries(all).filter(([, v]) => v.trim() === '')).toEqual([]);
  });

  it('ひらがなモードに漢字が混ざっていない', () => {
    const kanji = /[一-鿿]/;
    const offenders = Object.entries(hira as Record<string, string>)
      .filter(([, v]) => kanji.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
  });
});
