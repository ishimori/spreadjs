// display-format（DD-033-2・列見出しキャプション＋数値/日付の表示書式）: 利用側供給の「列→キャプション」と
// 「列→表示書式」を mount 時にプリコンパイルする純関数モジュール（DOM/内部 package 非依存＝TDD 対象）。
//
// 【設計方針（親 DD-033 決定③④⑤⑥／DD-033-2 📐）】
//   - 書式は **Canvas 描画テキストのみ**を整形する（要確認⑤）。cell-commit/setData round-trip・コピー TSV・
//     columnFormats（DD-027-3）の完全一致・編集ドラフトは従来の表示文字列（raw）のまま＝**契約不変**。
//     本モジュールは base-layer の formatCellText / columnHeaderLabel フックに束縛する「raw→display 写像」だけを
//     提供し、判定（数値右寄せ・columnFormats match・select 候補）には一切関与しない（判定は raw・描画は display）。
//   - number は **文字列ベースの十進演算**（float/toFixed 非経由＝2進誤差なし・決定的）。raw が数値形（NUMERIC_RE）
//     のときだけ整形し、非数値 raw は素通しする。half-up 丸め・decimals 未指定=丸めなし・grouping=カンマ固定・
//     percent は丸め前に小数点2桁右シフト・出力順 `prefix + 本体 + ('%') + suffix`（要確認3）。
//   - date は **フィールド直取り**（Date オブジェクト/タイムゾーン変換を経由しない＝環境非依存・決定的）。受理形は
//     `YYYY-MM-DD` と `YYYY-MM-DD[T|空白]HH:mm(:ss)` のみ。非受理形・時刻欠落 raw への時刻トークンは raw 素通し
//     （00 を埋めない・セル単位診断なし・要確認4）。
//   - 負の数（DD-059）: `negative.style` で表記（`-`・`▲`・括弧）を、`negative.color` で文字色を変える。表示上も負に
//     なる数値だけが対象（0 に丸まる負数は上の -0 正規化で非負になる＝括弧・▲・色を付けない）。▲ は `-` と同じ位置、
//     括弧は prefix〜suffix の全体を囲む。色と括弧の右余白（正の数と 0 に `)` 1文字分・Excel の `_)`）は文字列に
//     できないため、formatText とは別の decorationFor が列ごとの不変オブジェクトで返す（base-layer の
//     cellTextDecoration に束縛。文字色の優先順位は columnFormats の textColor ＞ 負の数の color ＞ 既定の数値色）。
//   - 不正設定（未知列・空/空白キャプション・不正 type・decimals 非整数/0〜20外・pattern 空/既知トークン皆無・
//     negative の不正 style/空 color・wrap/link 併用）は mount 時に fail-fast（DisplayConfigError → 公開
//     code=`column-display-invalid`）。
//
// 【R7 注意】本モジュールは公開型（GridColumnDisplayFormat）を定義するため index.ts から到達可能＝公開宣言 closure
//   に含まれる（facade-surface contract）。内部 package（render 等）を import すると R7 違反になるため import しない。
//   render へは grid の型を渡さず**構造フック注入**のみ（base-layer の formatCellText/columnHeaderLabel/
//   cellTextDecoration は plain 関数）。
//
// 【併用制約（要確認1〜2・DD-033-2 決定）】
//   - wrapColumns 同一列の表示書式は fail-fast（自動行高が raw の wrapLines で計算され描画だけ書式済みになる構造不整合）。
//   - link 列の表示書式は fail-fast（表示整形とクリック対象 raw URL の乖離）。select 列は許可（構造不整合なし・
//     候補/検証/ドロップダウン表示は raw のまま）。columnFormats（DD-027-3）とは併用可（match は raw 完全一致のまま）。
//   - caption は wrap/link/select いずれの列でも許可（ヘッダーのみ・セル描画契約に影響しない）。
//
// 【拡張点メモ（v1 対象外・実装しない）】
//   Excel 書式文字列互換・Intl/ロケール書式（`Intl.NumberFormat`/`DateTimeFormat` 委譲）・負の数の △ 表記・
//   数値シリアル日付・2段ヘッダー。複数実案件で要求されたら別DDで I/F 拡張を判断する（負数の色/括弧/▲ は DD-059 で追加）。

/** number 表示書式（Experimental 0.x・DD-033-2）。すべて任意（未指定＝raw の桁のまま素の十進表記）。 */
export interface GridNumberDisplayFormat {
  readonly type: 'number';
  /** true=整数部を3桁カンマ区切りにする（ロケール非依存の固定カンマ）。 */
  readonly grouping?: boolean;
  /** 小数桁数（0〜20 の整数）。指定時は half-up 丸め＋末尾ゼロ埋め。未指定=丸めなし（raw の桁のまま）。 */
  readonly decimals?: number;
  /** true=100 倍（小数点2桁右シフト）して末尾に `%` を付ける。シフトは decimals 丸めの前に行う。 */
  readonly percent?: boolean;
  /** 本体の前に付ける文字列（通貨記号等・そのまま連結）。 */
  readonly prefix?: string;
  /** 本体（と `%`）の後に付ける文字列（単位等・そのまま連結）。 */
  readonly suffix?: string;
  /** 負の数の表記と文字色（DD-059）。未指定=従来どおり `-1,234`・既定の数値色。 */
  readonly negative?: GridNegativeNumberFormat;
}

/**
 * 負の数の表示（Experimental 0.x・DD-059）。Excel の `#,##0_);[Red](#,##0)` の負セクションにあたる。表示上も負になる
 * 数値だけに効き、0 に丸まる負数（decimals=1 の -0.04 → `0.0`）は負として扱わない。
 */
export interface GridNegativeNumberFormat {
  /**
   * 負の数の表記。`'minus'`（既定）=`-1,234`・`'triangle'`=`▲1,234`（`-` と同じ位置＝prefix の後）・
   * `'parentheses'`=`(1,234)`（prefix〜suffix の全体を囲む）。`'parentheses'` の列では正の数と 0 の右に
   * `)` 1文字分の余白を取り、正負の一の位をそろえる（Excel の `_)`）。
   */
  readonly style?: 'minus' | 'parentheses' | 'triangle';
  /** 負の数の文字色（CSS color・妥当性は検査しない）。columnFormats の textColor が一致したセルはそちらが優先する。 */
  readonly color?: string;
}

/**
 * date 表示書式（Experimental 0.x・DD-033-2）。`pattern` はトークン（`YYYY`/`MM`/`DD`/`HH`/`mm`/`ss`）を含む文字列で、
 * トークン以外はリテラル素通し（`YYYY/MM/DD` の `/` 等）。受理形は ISO 2形のみ（フィールド直取り・TZ 非経由）。
 */
export interface GridDateDisplayFormat {
  readonly type: 'date';
  readonly pattern: string;
}

/** 列表示書式の判別 union（Experimental 0.x・DD-033-2）。 */
export type GridColumnDisplayFormat = GridNumberDisplayFormat | GridDateDisplayFormat;

/**
 * columnCaptions/columnDisplayFormats 設定の不正を fail-fast で通知する内部エラー（AC7）。mount-controller が
 * catch して公開 `error`（phase=config・**安定 code**=`column-display-invalid`）へ写像する（ColumnTypeConfigError と
 * 同経路・相乗りしない）。`message` はそのまま公開 error の `message` として渡す（利用側が与える設定値＝機微情報でない・
 * 違反列/理由を開発者が特定できるようにする）。公開されるのは安定 code のみで、内部 `reason` enum は露出しない。
 */
export class DisplayConfigError extends Error {
  constructor(
    /** 機械可読な理由（診断用・公開はしない）。 */
    readonly reason:
      | 'unknown-column'
      | 'empty-caption'
      | 'invalid-type'
      | 'invalid-decimals'
      | 'invalid-pattern'
      | 'invalid-negative'
      | 'wrap-conflict'
      | 'link-conflict',
    /** 対象列 ID（診断用）。 */
    readonly columnId: string,
    message: string,
  ) {
    super(message);
    this.name = 'DisplayConfigError';
  }
}

/**
 * 描画テキストの装飾（DD-059・負の数の色と括弧表記の右余白）。列ごとにプリコンパイルした不変オブジェクトで、
 * base-layer の描画契約型 ResolvedTextDecoration と**構造同一**（R7: render の型を import しない）。
 */
export interface DisplayTextDecoration {
  /** 文字色（負の数の color）。 */
  readonly textColor?: string;
  /** 数値の右に空ける余白の文字（括弧表記の列の正の数と 0 = `)`）。描画側がセルのフォントで測った幅だけ右端をあける。 */
  readonly trailingPad?: string;
}

/** プリコンパイル済みの表示解決器（列→display 写像・列→caption。base-layer フックが束縛する）。 */
export interface CompiledColumnDisplay {
  /** 列 ID・raw 表示値 → 描画テキスト（display）。書式のない列・非該当 raw は raw をそのまま返す。 */
  formatText(columnId: string, raw: string): string;
  /** 列 ID・raw 表示値 → 描画テキストの装飾（DD-059）。負の数の書式がない列・非数値 raw・装飾のない符号は undefined。 */
  decorationFor(columnId: string, raw: string): DisplayTextDecoration | undefined;
  /** 列 ID → ヘッダーキャプション（未指定列は undefined＝既定ラベルを使う）。 */
  captionFor(columnId: string): string | undefined;
  /** キャプション or 表示書式が 1 つでもあるか（base-layer フックの束縛要否＝無ければ描画コスト増ゼロ）。 */
  hasAny(): boolean;
  /** 装飾（負の数の color か括弧表記）のある列が 1 つでもあるか（cellTextDecoration フックの束縛要否）。 */
  hasDecorations(): boolean;
}

/** wrap/link 併用検査のための列種別プレディケート（mount-controller が columnTypeRegistry/wrapColumns から渡す）。 */
export interface DisplayColumnUsage {
  readonly isWrapColumn?: (columnId: string) => boolean;
  readonly isLinkColumn?: (columnId: string) => boolean;
}

/** raw が base-layer と同一の数値形か（`isNumericCell` と同一・右寄せ/整形の適用条件）。指数表記・カンマ入りは不一致。 */
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
/** 日付のみ（正準 CellScalar date）。 */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 日時（T もしくは空白区切り・秒は任意）。フィールドを直取りしタイムゾーン変換を経由しない。 */
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** negative.style の受理値（DD-059）。 */
const NEGATIVE_STYLES: readonly string[] = ['minus', 'parentheses', 'triangle'];
/** 括弧表記の列で正の数と 0 に付ける装飾（右に `)` 1文字分の余白・Excel の `_)`）。全列で共有する不変オブジェクト。 */
const PARENTHESES_PAD: DisplayTextDecoration = Object.freeze({ trailingPad: ')' });

/** date パターンの既知トークン（長いものから照合＝`YYYY` を優先）。 */
const DATE_TOKENS = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'] as const;
type DateToken = (typeof DATE_TOKENS)[number];

type DatePatternPart = { readonly kind: 'token'; readonly token: DateToken } | { readonly kind: 'literal'; readonly text: string };

/** パターンをトークン/リテラルの列へ分解する（トークンは最長一致・大文字小文字を区別）。 */
function tokenizeDatePattern(pattern: string): DatePatternPart[] {
  const parts: DatePatternPart[] = [];
  let i = 0;
  while (i < pattern.length) {
    const token = DATE_TOKENS.find((t) => pattern.startsWith(t, i));
    if (token !== undefined) {
      parts.push({ kind: 'token', token });
      i += token.length;
    } else {
      parts.push({ kind: 'literal', text: pattern[i]! });
      i += 1;
    }
  }
  return parts;
}

/** 桁文字列に 1 を加える（"199"→"200"・"999"→"1000"）。 */
function incrementDigits(digits: string): string {
  const arr = digits.split('');
  let i = arr.length - 1;
  while (i >= 0) {
    if (arr[i] === '9') {
      arr[i] = '0';
      i -= 1;
    } else {
      arr[i] = String.fromCharCode(arr[i]!.charCodeAt(0) + 1);
      break;
    }
  }
  if (i < 0) {
    arr.unshift('1');
  }
  return arr.join('');
}

/** 先頭ゼロを除く（すべてゼロなら "0" を残す）。 */
function stripLeadingZeros(digits: string): string {
  const stripped = digits.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

/** 整数部桁へ3桁カンマを挿入する（符号・小数点は含まない純粋な桁列）。 */
function addThousands(digits: string): string {
  if (digits.length <= 3) {
    return digits;
  }
  let out = '';
  let count = 0;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out = digits[i]! + out;
    count += 1;
    if (count % 3 === 0 && i > 0) {
      out = `,${out}`;
    }
  }
  return out;
}

/** 小数点を右へ n 桁シフトする（×10^n・文字列演算＝2進誤差なし）。 */
function shiftPointRight(intDigits: string, fracDigits: string, n: number): { intDigits: string; fracDigits: string } {
  let frac = fracDigits;
  while (frac.length < n) {
    frac += '0';
  }
  return { intDigits: intDigits + frac.slice(0, n), fracDigits: frac.slice(n) };
}

/** decimals 桁へ half-up 丸め（不足桁はゼロ埋め）。intDigits/fracDigits は符号なしの桁列。 */
function roundHalfUp(intDigits: string, fracDigits: string, decimals: number): { intDigits: string; fracDigits: string } {
  if (fracDigits.length <= decimals) {
    return { intDigits, fracDigits: fracDigits.padEnd(decimals, '0') };
  }
  const keep = fracDigits.slice(0, decimals);
  const roundDigit = fracDigits.charCodeAt(decimals) - 48;
  let combined = intDigits + keep;
  if (roundDigit >= 5) {
    combined = incrementDigits(combined);
  }
  const fracOut = decimals === 0 ? '' : combined.slice(combined.length - decimals);
  const intOut = decimals === 0 ? combined : combined.slice(0, combined.length - decimals);
  return { intDigits: intOut === '' ? '0' : intOut, fracDigits: fracOut };
}

/** number 書式で整形した数値（符号・prefix・suffix を除く本体〔`%` まで〕と、表示上も負か）。 */
interface FormattedNumber {
  readonly body: string;
  readonly negative: boolean;
}

/** number 表示書式の本体を整形する（非数値 raw は null・文字列十進・決定的）。符号と prefix/suffix は呼び出し側が付ける。 */
function formatNumberBody(raw: string, fmt: GridNumberDisplayFormat): FormattedNumber | null {
  if (!NUMERIC_RE.test(raw)) {
    return null;
  }
  let negative = raw.startsWith('-');
  const magnitude = negative ? raw.slice(1) : raw;
  const dot = magnitude.indexOf('.');
  let intDigits = dot < 0 ? magnitude : magnitude.slice(0, dot);
  let fracDigits = dot < 0 ? '' : magnitude.slice(dot + 1);

  // percent: 丸めの前に小数点2桁右シフト（要確認3）。
  if (fmt.percent === true) {
    ({ intDigits, fracDigits } = shiftPointRight(intDigits, fracDigits, 2));
  }
  // decimals: half-up 丸め（未指定=丸めなし＝raw の桁のまま）。
  if (fmt.decimals !== undefined) {
    ({ intDigits, fracDigits } = roundHalfUp(intDigits, fracDigits, fmt.decimals));
  }
  intDigits = stripLeadingZeros(intDigits);
  // -0（例: -0.04 を decimals=1 で丸め → -0.0）は 0 へ正規化する（嘘の負符号を描かない・括弧/▲/色も付けない）。
  if (negative && /^0*$/.test(intDigits) && /^0*$/.test(fracDigits)) {
    negative = false;
  }
  const intOut = fmt.grouping === true ? addThousands(intDigits) : intDigits;
  const body = `${intOut}${fracDigits.length > 0 ? `.${fracDigits}` : ''}${fmt.percent === true ? '%' : ''}`;
  return { body, negative };
}

/** number 表示書式を適用する（非数値 raw は素通し・文字列十進・決定的）。 */
function formatNumber(raw: string, fmt: GridNumberDisplayFormat): string {
  const formatted = formatNumberBody(raw, fmt);
  if (formatted === null) {
    return raw;
  }
  const prefix = fmt.prefix ?? '';
  const suffix = fmt.suffix ?? '';
  if (!formatted.negative) {
    return `${prefix}${formatted.body}${suffix}`;
  }
  // DD-059: 負の数の表記。▲ は `-` と同じ位置（prefix の後）、括弧は prefix〜suffix の全体を囲む。
  switch (fmt.negative?.style) {
    case 'parentheses':
      return `(${prefix}${formatted.body}${suffix})`;
    case 'triangle':
      return `${prefix}▲${formatted.body}${suffix}`;
    default:
      return `${prefix}-${formatted.body}${suffix}`;
  }
}

/** 負の数の書式がある列の装飾（DD-059）。表示上の正負で引き分ける（どちらも無い列は登録しない）。 */
interface NumberDecoration {
  readonly format: GridNumberDisplayFormat;
  /** 表示上も負になる数値の装飾（color 指定時）。 */
  readonly negative: DisplayTextDecoration | undefined;
  /** 正の数と 0 の装飾（括弧表記の右余白）。 */
  readonly nonNegative: DisplayTextDecoration | undefined;
}

/** 数値 raw の装飾を引く（非数値 raw は undefined＝素通し・左寄せの値には付けない）。 */
function decorateNumber(raw: string, decoration: NumberDecoration): DisplayTextDecoration | undefined {
  // `-` で始まらない数値は丸めても負にならない＝整形せずに判定する（描画ホットパスの二重整形を避ける）。
  if (!raw.startsWith('-')) {
    return NUMERIC_RE.test(raw) ? decoration.nonNegative : undefined;
  }
  const formatted = formatNumberBody(raw, decoration.format);
  if (formatted === null) {
    return undefined;
  }
  return formatted.negative ? decoration.negative : decoration.nonNegative;
}

/** negative 設定を検査する（不正 style・空/非文字列 color・非オブジェクトは fail-fast）。 */
function validateNegative(columnId: string, negative: unknown): void {
  if (typeof negative !== 'object' || negative === null) {
    throw new DisplayConfigError(
      'invalid-negative',
      columnId,
      `columnDisplayFormats: 列 "${columnId}" の negative はオブジェクトで指定する（{ style?, color? }）`,
    );
  }
  const { style, color } = negative as { style?: unknown; color?: unknown };
  if (style !== undefined && !NEGATIVE_STYLES.includes(style as string)) {
    throw new DisplayConfigError(
      'invalid-negative',
      columnId,
      `columnDisplayFormats: 列 "${columnId}" の negative.style="${String(style)}" が不正（minus|parentheses|triangle）`,
    );
  }
  // 空/空白のみの色は「死に設定」＝黙って無効化せず fail-fast する（columnBackgrounds の empty-color と同じ理由）。
  if (color !== undefined && (typeof color !== 'string' || color.trim() === '')) {
    throw new DisplayConfigError(
      'invalid-negative',
      columnId,
      `columnDisplayFormats: 列 "${columnId}" の negative.color が空（CSS color 文字列が必要）`,
    );
  }
}

/** date 表示書式を適用する（受理形のみ整形・非受理/時刻欠落＋時刻トークンは raw 素通し）。 */
function formatDate(raw: string, parts: readonly DatePatternPart[]): string {
  let fields: Partial<Record<DateToken, string | undefined>>;
  const dt = DATE_TIME_RE.exec(raw);
  if (dt !== null) {
    fields = { YYYY: dt[1], MM: dt[2], DD: dt[3], HH: dt[4], mm: dt[5], ss: dt[6] };
  } else {
    const d = DATE_ONLY_RE.exec(raw);
    if (d === null) {
      return raw; // 非受理形（数値シリアル・和暦・スラッシュ入力等）は素通し。
    }
    fields = { YYYY: d[1], MM: d[2], DD: d[3] };
  }
  // 時刻フィールド欠落 raw に時刻トークン（HH/mm/ss）がある場合は 00 を埋めず raw 素通し（要確認4）。
  for (const part of parts) {
    if (part.kind === 'token' && fields[part.token] === undefined) {
      return raw;
    }
  }
  return parts.map((part) => (part.kind === 'token' ? fields[part.token]! : part.text)).join('');
}

/**
 * columnCaptions/columnDisplayFormats（mount オプション）と columnOrder から表示解決器をプリコンパイルする
 * （fail-fast・AC7）。両オプション未指定/空なら「表示なし」解決器を返す（現行描画と完全一致・hasAny=false・AC9）。
 * 不正設定は DisplayConfigError を throw する（mount-controller が `column-display-invalid` へ写像）。
 *
 * @param usage wrap/link 併用検査のプレディケート（表示書式列にのみ適用。caption 列は検査しない）。未指定なら併用なし。
 */
export function compileDisplayFormats(
  displayFormats: Readonly<Record<string, GridColumnDisplayFormat>> | undefined,
  captions: Readonly<Record<string, string>> | undefined,
  columnOrder: readonly string[],
  usage?: DisplayColumnUsage,
): CompiledColumnDisplay {
  const columnSet = new Set(columnOrder.map((c) => String(c)));
  const isWrapColumn = usage?.isWrapColumn ?? (() => false);
  const isLinkColumn = usage?.isLinkColumn ?? (() => false);
  const captionMap = new Map<string, string>();
  const formatterMap = new Map<string, (raw: string) => string>();
  const decorationMap = new Map<string, NumberDecoration>();

  if (captions !== undefined) {
    for (const [columnId, caption] of Object.entries(captions)) {
      if (!columnSet.has(columnId)) {
        throw new DisplayConfigError(
          'unknown-column',
          columnId,
          `columnCaptions: 未知の列 "${columnId}"（columnOrder に存在しない）`,
        );
      }
      if (caption.trim() === '') {
        throw new DisplayConfigError(
          'empty-caption',
          columnId,
          `columnCaptions: 列 "${columnId}" のキャプションが空/空白（見出しを描けない）`,
        );
      }
      captionMap.set(columnId, caption);
    }
  }

  if (displayFormats !== undefined) {
    for (const [columnId, format] of Object.entries(displayFormats)) {
      if (!columnSet.has(columnId)) {
        throw new DisplayConfigError(
          'unknown-column',
          columnId,
          `columnDisplayFormats: 未知の列 "${columnId}"（columnOrder に存在しない）`,
        );
      }
      // 表示整形（display）と描画契約が両立しない併用を fail-fast する（caption は対象外）。
      if (isWrapColumn(columnId)) {
        throw new DisplayConfigError(
          'wrap-conflict',
          columnId,
          `columnDisplayFormats: 列 "${columnId}" は wrapColumns（折り返し）と併用できない`
            + `（自動行高は raw で計算され描画だけ書式済みになる構造不整合のため・DD-033-2）`,
        );
      }
      if (isLinkColumn(columnId)) {
        throw new DisplayConfigError(
          'link-conflict',
          columnId,
          `columnDisplayFormats: リンク列 "${columnId}" は表示書式と併用できない`
            + `（表示整形とクリック対象 raw URL が乖離するため・DD-033-2）`,
        );
      }
      const type = (format as { type: string }).type;
      if (type === 'number') {
        const number = format as GridNumberDisplayFormat;
        if (number.decimals !== undefined) {
          if (!Number.isInteger(number.decimals) || number.decimals < 0 || number.decimals > 20) {
            throw new DisplayConfigError(
              'invalid-decimals',
              columnId,
              `columnDisplayFormats: 列 "${columnId}" の decimals=${String(number.decimals)} が不正（0〜20 の整数）`,
            );
          }
        }
        if (number.negative !== undefined) {
          validateNegative(columnId, number.negative);
          // 色・括弧の右余白は文字列にできない＝列ごとの不変オブジェクトとして decorationFor が返す（DD-059）。
          const negative = number.negative.color === undefined ? undefined : Object.freeze({ textColor: number.negative.color });
          const nonNegative = number.negative.style === 'parentheses' ? PARENTHESES_PAD : undefined;
          if (negative !== undefined || nonNegative !== undefined) {
            decorationMap.set(columnId, { format: number, negative, nonNegative });
          }
        }
        formatterMap.set(columnId, (raw) => formatNumber(raw, number));
      } else if (type === 'date') {
        const date = format as GridDateDisplayFormat;
        const parts = tokenizeDatePattern(date.pattern);
        if (!parts.some((p) => p.kind === 'token')) {
          throw new DisplayConfigError(
            'invalid-pattern',
            columnId,
            `columnDisplayFormats: 列 "${columnId}" の date pattern "${date.pattern}" に既知トークンがない`
              + `（YYYY/MM/DD/HH/mm/ss のいずれかを含めること）`,
          );
        }
        formatterMap.set(columnId, (raw) => formatDate(raw, parts));
      } else {
        throw new DisplayConfigError(
          'invalid-type',
          columnId,
          `columnDisplayFormats: 列 "${columnId}" の未対応 type "${type}"（number|date のみ）`,
        );
      }
    }
  }

  const hasAny = captionMap.size > 0 || formatterMap.size > 0;
  const hasDecorations = decorationMap.size > 0;
  return {
    formatText: (columnId, raw) => {
      const formatter = formatterMap.get(columnId);
      return formatter === undefined ? raw : formatter(raw);
    },
    decorationFor: (columnId, raw) => {
      const decoration = decorationMap.get(columnId);
      return decoration === undefined ? undefined : decorateNumber(raw, decoration);
    },
    captionFor: (columnId) => captionMap.get(columnId),
    hasAny: () => hasAny,
    hasDecorations: () => hasDecorations,
  };
}
