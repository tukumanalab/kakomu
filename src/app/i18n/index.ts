/**
 * 2 段階の読みやすさ切り替え。
 *
 * 方針（SPEC 3.2）:
 *   ひらがなは機械変換ではなく、人が言い換えを書き下ろす。
 *   「背景」に読み仮名を振っても低学年には意味が伝わらないため。
 *
 * ひらがなモードで変わるのは 文言 / 書体 / 文字サイズ / 行間 / 単位 の 5 つだけ。
 * 画面の構造・ボタンの位置・機能は変わらない。
 *
 * ---------------------------------------------------------------------------
 * いまは漢字モードだけを使う。
 * まず機能を作りきることを優先するため、切り替えを UI から外している。
 * ひらがなの文言（ja-hira.json）と仕組みは消さずに残してあるので、
 * 戻すときは READING_SWITCH_ENABLED を true にして、
 * ツールバーに切り替えを戻すだけでよい。
 * ---------------------------------------------------------------------------
 */

import { createSignal } from 'solid-js';
import ja from './ja.json';
import hira from './ja-hira.json';

export type ReadingLevel = 'kanji' | 'hira';

type Dict = Record<string, string>;

const DICTS: Record<ReadingLevel, Dict> = {
  kanji: ja as Dict,
  hira: hira as Dict,
};

const STORAGE_KEY = 'kakomu.reading';

/** 切り替えを使うかどうか。当面は漢字だけ */
export const READING_SWITCH_ENABLED = false;

function load(): ReadingLevel {
  if (!READING_SWITCH_ENABLED) return 'kanji';
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'hira' || v === 'kanji') return v;
  } catch {
    // localStorage が使えない環境でも動く
  }
  return 'kanji';
}

const [level, setLevelSignal] = createSignal<ReadingLevel>(load());

export { level as readingLevel };

export function setReadingLevel(next: ReadingLevel): void {
  if (!READING_SWITCH_ENABLED) return;
  setLevelSignal(next);
  document.documentElement.dataset.read = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 保存できなくても動作は変えない
  }
}

/** 起動時に一度呼ぶ */
export function initI18n(): void {
  document.documentElement.dataset.read = level();
  if (!READING_SWITCH_ENABLED) {
    // 前に「ひらがな」で使っていた人が、切り替えを外したあとも
    // ひらがなのまま取り残されないよう、保存された選択を消しておく
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 消せなくても漢字で動く
    }
  }
}

/**
 * 文言を引く。
 * `{name}` 形式のプレースホルダを params で置換する。
 * キーが無い場合はキー自身を返す（開発中に欠落が目に見えるように）。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = DICTS[level()];
  let s = dict[key] ?? DICTS.kanji[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

/** 数値を「12.3ミリ」のように書く。ひらがなモードでも単位はカタカナ */
export function mm(value: number, digits = 1): string {
  return `${value.toFixed(digits)}${t('unit.mm')}`;
}

export function deg(value: number, digits = 0): string {
  return `${value.toFixed(digits)}${t('unit.deg')}`;
}

/** テストから参照する。全キーの網羅を CI で検査するため */
export const DICTIONARIES = DICTS;
