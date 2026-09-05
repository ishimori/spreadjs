import type { GridBorder, GridRowBorders, GridColumnBorders } from '@nanairo-sheet/grid';

/** DD-047 playground: rowborder=r5:top:2:ff0000 / colborder=col-b:right:2:64748b。 */
export function borderOptions(params: URLSearchParams): {
  rowBorders?: Record<string, GridRowBorders>;
  columnBorders?: Record<string, GridColumnBorders>;
} {
  const result: ReturnType<typeof borderOptions> = {};
  for (const name of ['rowborder', 'colborder'] as const) {
    const raw = params.get(name);
    if (raw === null) continue;
    if (name === 'rowborder') result.rowBorders = {};
    else result.columnBorders = {};
    for (const item of raw.split(';')) {
      const [id, edge, size, ...rest] = item.split(':');
      if (id === undefined || edge === undefined || size === undefined) continue;
      const color = rest.join(':');
      const border: GridBorder = { width: Number(size), color: /^[0-9a-f]{3,8}$/i.test(color) ? `#${color}` : color };
      if (name === 'rowborder' && (edge === 'top' || edge === 'bottom')) {
        result.rowBorders ??= {};
        result.rowBorders[id] = { ...result.rowBorders[id], [edge]: border };
      } else if (name === 'colborder' && (edge === 'left' || edge === 'right')) {
        result.columnBorders ??= {};
        result.columnBorders[id] = { ...result.columnBorders[id], [edge]: border };
      }
    }
  }
  return result;
}
