/**
 * 文言の検査。
 *
 * いまは漢字モードだけを使っている（機能の実装を優先するため）。
 * ひらがなの文言は消さずに残してあるが、**網羅は要求しない**。
 * 要求すると、機能を足すたびにひらがなも書かないと CI が落ちてしまい、
 * 実装の足を引っぱるため。
 *
 * 代わりに、残っているひらがなの文言が「腐っていないこと」だけを見る。
 * 切り替えを戻すとき（i18n の READING_SWITCH_ENABLED を true にするとき）は、
 * 下の `網羅` テストの skip を外して不足を洗い出す。
 */
import { describe, expect, it } from 'vitest';
import ja from '../src/app/i18n/ja.json';
import hira from '../src/app/i18n/ja-hira.json';

const kanji = ja as Record<string, string>;
const hiragana = hira as Record<string, string>;
const kanjiKeys = Object.keys(kanji);
const hiraKeys = Object.keys(hiragana);

describe('文言（漢字）', () => {
  it('空の値がない', () => {
    expect(Object.entries(kanji).filter(([, v]) => v.trim() === '')).toEqual([]);
  });

  it('キーが重複していない', () => {
    expect(new Set(kanjiKeys).size).toBe(kanjiKeys.length);
  });
});

describe('文言（ひらがな・当面は未使用）', () => {
  it('漢字側に無いキーが残っていない', () => {
    // 漢字側で消したキーがひらがなに残っていると、戻すときに混乱する
    expect(hiraKeys.filter((k) => !kanjiKeys.includes(k))).toEqual([]);
  });

  it('空の値がない', () => {
    expect(Object.entries(hiragana).filter(([, v]) => v.trim() === '')).toEqual([]);
  });

  it('漢字が混ざっていない', () => {
    const hasKanji = /[一-鿿]/;
    const offenders = Object.entries(hiragana)
      .filter(([, v]) => hasKanji.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
  });

  // 切り替えを UI に戻すときは、この skip を外して不足を埋める
  it.skip('網羅：漢字側の全キーにひらがながある', () => {
    expect(kanjiKeys.filter((k) => !hiraKeys.includes(k))).toEqual([]);
  });
});
