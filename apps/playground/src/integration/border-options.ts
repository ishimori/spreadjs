import type { GridBorder, GridRowBorders, GridColumnBorders } from '@nanairo-sheet/grid';

/** DD-048 playground: rowborder=r5:top:2:ff0000:dotted / defaultrowborder=1:cbd5e1:dotted。 */
export function borderOptions(params: URLSearchParams): {
  rowBorders?: Record<string, GridRowBorders>;
  columnBorders?: Record<string, GridColumnBorders>;
  defaultRowBorder?: GridBorder;
} {
  const result: ReturnType<typeof borderOptions> = {};
  function parse(size: string, color: string, style: string | undefined): GridBorder {
    // URLの不正styleもSDKのfail-fast検証へ渡すハーネス境界。
    return { width: Number(size), color: /^[0-9a-f]{3,8}$/i.test(color) ? `#${color}` : color, ...(style === undefined ? {} : { style: style as GridBorder['style'] }) };
  }
  const defaultRow = params.get('defaultrowborder');
  if (defaultRow !== null) {
    const [size = '', color = '', style] = defaultRow.split(':');
    result.defaultRowBorder = parse(size, color, style);
  }
  for (const name of ['rowborder', 'colborder'] as const) {
    const raw = params.get(name);
    if (raw === null) continue;
    if (name === 'rowborder') result.rowBorders = {};
    else result.columnBorders = {};
    for (const item of raw.split(';')) {
      const [id, edge, size, color = '', style] = item.split(':');
      if (id === undefined || edge === undefined || size === undefined) continue;
      const border = parse(size, color, style);
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
