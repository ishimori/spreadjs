// DD-047: IDベースの表示専用罫線。公開宣言closureなので内部packageをimportしない。

/** 実線。widthはCSS px（有限の0超〜8以下）、colorはCanvasで解釈できるCSS色。 */
export interface GridBorder {
  readonly color: string;
  readonly width: number;
}

/** 行全体の上下境界。mount時固定・文書へ保存しない。 */
export interface GridRowBorders {
  readonly top?: GridBorder;
  readonly bottom?: GridBorder;
}

/** 列全体の左右境界。mount時固定・文書へ保存しない。 */
export interface GridColumnBorders {
  readonly left?: GridBorder;
  readonly right?: GridBorder;
}

export class BorderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BorderConfigError';
  }
}

/** 同幅なら後側（下行top／右列left）が勝つ。キー順に依存しない。 */
export function resolveBorder(before: GridBorder | undefined, after: GridBorder | undefined): GridBorder | undefined {
  if (before === undefined) return after;
  if (after === undefined) return before;
  return before.width > after.width ? before : after;
}

export interface CompiledBorders {
  readonly rowIds: readonly string[];
  readonly hasRows: boolean;
  readonly hasColumns: boolean;
  row(beforeId: string | undefined, afterId: string | undefined): GridBorder | undefined;
  column(beforeId: string | undefined, afterId: string | undefined): GridBorder | undefined;
}

/** CSS解釈だけ注入し、ID解決・検証はDOM非依存に保つ。返却styleはコピーしてfreezeする。 */
export function compileBorders(
  rowBorders: Readonly<Record<string, GridRowBorders>> | undefined,
  columnBorders: Readonly<Record<string, GridColumnBorders>> | undefined,
  columnOrder: readonly string[],
  normalizeColor: (color: string) => string | undefined,
): CompiledBorders {
  const rows = new Map<string, GridRowBorders>();
  const columns = new Map<string, GridColumnBorders>();
  const columnIds = new Set(columnOrder);
  function border(value: GridBorder | undefined, label: string): GridBorder | undefined {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object' || !Number.isFinite(value.width) || value.width <= 0 || value.width > 8) {
      throw new BorderConfigError(`${label}: widthは有限のCSS px（0超〜8以下）が必要`);
    }
    const color = typeof value.color === 'string' && value.color.trim() !== '' ? normalizeColor(value.color.trim()) : undefined;
    if (color === undefined) throw new BorderConfigError(`${label}: Canvasが解釈できるCSS colorが必要`);
    return Object.freeze({ color, width: value.width });
  }
  for (const [id, edges] of Object.entries(rowBorders ?? {})) {
    if (edges === null || typeof edges !== 'object') throw new BorderConfigError(`rowBorders.${id}: 辺オブジェクトが必要`);
    const top = border(edges.top, `rowBorders.${id}.top`);
    const bottom = border(edges.bottom, `rowBorders.${id}.bottom`);
    if (top !== undefined || bottom !== undefined) rows.set(id, Object.freeze({ top, bottom }));
  }
  for (const [id, edges] of Object.entries(columnBorders ?? {})) {
    if (!columnIds.has(id)) throw new BorderConfigError(`columnBorders: 未知の列 "${id}"`);
    if (edges === null || typeof edges !== 'object') throw new BorderConfigError(`columnBorders.${id}: 辺オブジェクトが必要`);
    const left = border(edges.left, `columnBorders.${id}.left`);
    const right = border(edges.right, `columnBorders.${id}.right`);
    if (left !== undefined || right !== undefined) columns.set(id, Object.freeze({ left, right }));
  }
  return {
    rowIds: Object.freeze([...rows.keys()]),
    hasRows: rows.size > 0,
    hasColumns: columns.size > 0,
    row: (before, after) => resolveBorder(before === undefined ? undefined : rows.get(before)?.bottom, after === undefined ? undefined : rows.get(after)?.top),
    column: (before, after) => resolveBorder(before === undefined ? undefined : columns.get(before)?.right, after === undefined ? undefined : columns.get(after)?.left),
  };
}

/** Canvasは不正色を無視するため、異なるsentinelを2回代入して検出する。既存の描画状態は復元する。 */
export function normalizeCanvasBorderColor(ctx: CanvasRenderingContext2D, color: string): string | undefined {
  const previous = ctx.fillStyle;
  try {
    ctx.fillStyle = '#010203';
    ctx.fillStyle = color;
    const first = ctx.fillStyle;
    ctx.fillStyle = '#040506';
    ctx.fillStyle = color;
    return first === ctx.fillStyle && typeof first === 'string' ? first : undefined;
  } finally {
    ctx.fillStyle = previous;
  }
}
