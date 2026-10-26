import { FormatRuleConfigError } from './format-rules';

/** 表示専用の描画設定。初回mountで固定し、値・選択・保存の契約には影響しない。 */
export interface GridAppearance {
  /** pxを含むCSS font shorthand（例: 14px Meiryo, sans-serif）。 */
  readonly cellFont?: string;
  readonly headerFont?: string;
  /** 列ごとのfont。列幅の自動調整・入力欄も同じfontを使う。 */
  readonly columnFonts?: Readonly<Record<string, string>>;
  readonly gridLineColor?: string;
}

export const DEFAULT_CELL_FONT = '13px system-ui, sans-serif';
export const DEFAULT_HEADER_FONT = '12px system-ui, sans-serif';

export interface CompiledAppearance {
  readonly cellFont: string;
  readonly headerFont: string;
  readonly gridLineColor: string | undefined;
  fontFor(columnId: string): string;
}

export function compileAppearance(
  input: GridAppearance | undefined,
  columns: readonly string[],
  validFont: (font: string) => boolean,
  normalizeColor: (color: string) => string | undefined,
): CompiledAppearance {
  const invalid = (): never => { throw new FormatRuleConfigError('invalid-appearance', '', 'appearanceのfontはpxを含むCSS font、色と列名は有効な値を指定してください'); };
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) invalid();
  const font = (value: string | undefined, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/\b\d+(?:\.\d+)?px\b/.test(value) || !validFont(value)) invalid();
    return value;
  };
  const cellFont = font(input?.cellFont, DEFAULT_CELL_FONT);
  const headerFont = font(input?.headerFont, DEFAULT_HEADER_FONT);
  const fonts = new Map<string, string>();
  if (input?.columnFonts !== undefined) {
    if (input.columnFonts === null || typeof input.columnFonts !== 'object' || Array.isArray(input.columnFonts)) invalid();
    for (const [id, value] of Object.entries(input.columnFonts)) {
      if (!columns.includes(id)) invalid();
      fonts.set(id, font(value, cellFont));
    }
  }
  let gridLineColor: string | undefined;
  if (input?.gridLineColor !== undefined) {
    if (typeof input.gridLineColor !== 'string') invalid();
    gridLineColor = normalizeColor(input.gridLineColor);
    if (gridLineColor === undefined) invalid();
  }
  return { cellFont, headerFont, gridLineColor, fontFor: (id) => fonts.get(id) ?? cellFont };
}
