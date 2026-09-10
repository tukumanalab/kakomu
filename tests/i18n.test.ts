/**
 * 文言の検査。
 *
 * 漢字とひらがなの 2 段階を使う（SPEC 3.2）。機能を足したら
 * ひらがなも書く。書き忘れは `網羅` のテストで CI が落とす。
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

describe('漢字モードにひらがなだけの言い回しが残っていない', () => {
  /**
   * 漢字モードは小学校高学年くらいから上が対象なので、普通の日本語で書く。
   * ひらがなモード用に書いた「もどす」「かさね」のような言い回しが
   * そのまま残っていると、どちらのモードでも中途半端になる（SPEC 3.4）。
   *
   * ひらがなが 4 文字以上つづく語を機械的に拾う。カタカナと、
   * 漢字が混ざった語は対象外。
   */
  const KANA_ONLY = /^[ぁ-んー]{4,}$/;

  /**
    * もともとひらがなで書くのが自然な語。漢字にするとかえって読みにくい。
    * ここに挙げたものは見逃す。
    */
  const ALLOWED = ['それぞれ', 'ください', 'とりあえず', 'かならず', 'なめらかさ'];

  it('4 文字以上のひらがなだけの語がない', () => {
    const offenders: string[] = [];
    for (const [key, value] of Object.entries(kanji)) {
      // 切り替えのラベル自体は、ひらがなであることに意味がある
      if (key.startsWith('read.')) continue;
      for (const word of value.split(/[、。\s（）「」]/)) {
        if (KANA_ONLY.test(word) && !ALLOWED.includes(word)) {
          offenders.push(`${key}: 「${word}」 in "${value}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('文言（ひらがな）', () => {
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

  // 切り替えを UI に戻したので、不足は CI で落とす
  it('網羅：漢字側の全キーにひらがながある', () => {
    expect(kanjiKeys.filter((k) => !hiraKeys.includes(k))).toEqual([]);
  });
});
