// 入力パーサー（型変換・標準セット）: 確定ドラフト文字列 → CellScalar（DD-012-1・§型変換）。
//
// 【設計方針】
// - **DOM・時刻・乱数に依存しない純粋関数**（core 所有＝値モデルの正準変換。cross-platform 決定的）。
// - IME composition 中の状態機械・textarea には一切関与しない。変換は **確定時の commit 経路**（commit-bridge）
//   がここへ委譲する（IME 不変条件を壊さない）。
// - 内部表現は計画書確定: 数値=IEEE754（JS number）／日付=LocalDate `YYYY-MM-DD`（JS Date を正規値にしない）。
//
// 【受理書式表（標準セット・確定＝Codex 検証対象）】
//   number:
//     - 半角整数        123 / 0 / -5
//     - 全角数字        １２３ / －５（全角数字・全角マイナスを半角へ正規化してから判定）
//     - 桁区切り        1,234 / 1,234,567 / -1,234（3桁グループ厳密。1,23 や 12,34 は非該当＝string）
//     - 小数            1.5 / 0.25 / -0.5 / 1,234.5
//   date（→ LocalDate YYYY-MM-DD へ正準化）:
//     - YYYY-MM-DD      2026-07-13 / 2026-7-3（月日は1〜2桁可・実在暦日のみ・0埋め正準化）
//     - YYYY/MM/DD      2026/07/13（同上・区切りは正準化で '-' へ）
//   string（＝上記いずれにも該当しない全て。偽陽性防止のため下記は string に留める）:
//     - 電話番号        090-1234-5678 / 03-1234-5678（年4桁でない・グループ数が日付と異なる）
//     - 型番/コード     ABC-123 / A1 / 型123（英字混在）
//     - 郵便番号        123-4567（年4桁でない）
//     - 実在しない日付  2026-13-01 / 2026-02-30（暦日検証で棄却）
//     - 前後空白付き    " 123 "（全体一致を要求。空白付きは変換しない＝予期せぬ変換を避ける）
//
// 【非該当は string】確信を持って number/date と判定できるものだけ変換し、それ以外は入力どおり string で保つ。
//   これにより「電話番号・型番が勝手に数値/日付化される」偽陽性を防ぐ（DA 観点）。

import type { CellScalar } from './operations';

/** 全角数字・全角マイナス/カンマ/ピリオドを半角へ正規化する（number/date 判定の前処理）。 */
function normalizeFullwidth(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xff10 && cp <= 0xff19) {
      // 全角数字 ０-９ → 0-9
      out += String.fromCharCode(cp - 0xff10 + 0x30);
    } else if (cp === 0xff0d || cp === 0x2212) {
      // 全角ハイフンマイナス（－）・数学マイナス（−）→ '-'
      out += '-';
    } else if (cp === 0xff0c) {
      // 全角カンマ（，）→ ','
      out += ',';
    } else if (cp === 0xff0e) {
      // 全角ピリオド（．）→ '.'
      out += '.';
    } else if (cp === 0xff0f) {
      // 全角スラッシュ（／）→ '/'（全角日付区切り。ADR-0012 の契約と整合・Codex P2）
      out += '/';
    } else {
      out += ch;
    }
  }
  return out;
}

// 数値: 符号 + （3桁区切り群 | 連続数字）+ 任意の小数部。全体一致（前後に余計な文字を許さない）。
//   桁区切り群: 先頭1〜3桁 + (,3桁)+  例) 1,234 / 12,345 / 1,234,567
//   区切りなし: \d+          例) 123 / 0 / 007
const NUMBER_GROUPED_RE = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const NUMBER_PLAIN_RE = /^-?\d+(?:\.\d+)?$/;

// 日付: YYYY(4桁) 区切り MM(1-2桁) 同一区切り DD(1-2桁)。区切りは '-' か '/'（混在不可）。
const DATE_RE = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/;

/** 実在する暦日か（月 1-12・日 1-末日・閏年考慮）を判定する。 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

/** 2桁ゼロ埋め。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 正規化済みテキストを LocalDate（YYYY-MM-DD）へ。非日付は null。 */
function tryParseDate(normalized: string): string | null {
  const m = DATE_RE.exec(normalized);
  if (m === null) {
    return null;
  }
  const year = Number(m[1]);
  const month = Number(m[3]);
  const day = Number(m[4]);
  if (!isRealCalendarDate(year, month, day)) {
    return null;
  }
  return `${m[1]}-${pad2(month)}-${pad2(day)}`;
}

/** 正規化済みテキストを number へ。非数値は null。 */
function tryParseNumber(normalized: string): number | null {
  if (!NUMBER_PLAIN_RE.test(normalized) && !NUMBER_GROUPED_RE.test(normalized)) {
    return null;
  }
  // 桁区切りを除去してから数値化（Number('1,234') は NaN のため）。
  const n = Number(normalized.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** parseCellInput の挙動オプション。 */
export interface ParseCellInputOptions {
  /**
   * RC12（DD-052-2）: true なら日付/数値判定をスキップし、非空テキストを常に string で保つ
   * （先頭ゼロ付き電話番号等、型変換で元の文字列表現が失われるのを防ぐ列向け）。空文字は forceString でも blank。
   */
  readonly forceString?: boolean;
}

/**
 * 確定ドラフト文字列を CellScalar へ変換する（標準セット）。
 * 空=blank／日付→date（YYYY-MM-DD 正準化）／数値→number（IEEE754）／それ以外→string（入力どおり）。
 *
 * 判定順: date → number → string（date と number の書式は重ならないため順序に依存しないが、
 * 意図を明示するため date を先に判定する。`2026` は number、`2026-07-13` は date）。
 * `options.forceString` が true なら date/number 判定自体を行わない（RC12・列単位の型変換無効化）。
 */
export function parseCellInput(text: string, options?: ParseCellInputOptions): CellScalar {
  if (text === '') {
    return { kind: 'blank' };
  }
  if (options?.forceString === true) {
    return { kind: 'string', value: text };
  }
  const normalized = normalizeFullwidth(text);

  const date = tryParseDate(normalized);
  if (date !== null) {
    return { kind: 'date', value: date };
  }

  const num = tryParseNumber(normalized);
  if (num !== null) {
    return { kind: 'number', value: num };
  }

  // 非該当は入力どおり（正規化前の生テキスト）を string で保つ（偽陽性変換を避ける）。
  return { kind: 'string', value: text };
}
