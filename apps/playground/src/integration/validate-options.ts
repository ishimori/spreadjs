import type { GridCellValidationInput } from '@nanairo-sheet/grid';

declare global {
  interface Window {
    /** DD-063 E2E: validateCell が呼ばれた回数（「検証しない経路」で増えないことを確かめる）。 */
    __validateCalls?: number;
  }
}

/** 列ごとの規則（`len8`=9文字以上・`ng`=値が NG・`date2000`=2000年より前・`throw`=例外を投げる）。 */
const RULES: Record<string, (value: string) => string | null> = {
  len8: (value) => (value.length > 8 ? '8桁を超えています' : null),
  ng: (value) => (value === 'NG' ? 'NG は使えません' : null),
  date2000: (value) => (value < '2000' ? '2000年より前は入力できません' : null),
  throw: () => {
    throw new Error('validateCell の不具合（E2E）');
  },
};

/**
 * DD-063 playground: `validate=col-b:len8,col-c:ng` を validateCell にする（未指定なら undefined＝検証なし）。
 * 呼ばれた回数を `window.__validateCalls` に数える。未知の規則名の列は通す。
 */
export function validateCellOption(params: URLSearchParams): { validateCell?: (cell: GridCellValidationInput) => string | null } {
  const raw = params.get('validate');
  if (raw === null || raw === '') {
    return {};
  }
  const byColumn = new Map<string, (value: string) => string | null>();
  for (const spec of raw.split(',')) {
    const colonAt = spec.lastIndexOf(':');
    const rule = RULES[spec.slice(colonAt + 1)];
    if (colonAt > 0 && rule !== undefined) {
      byColumn.set(spec.slice(0, colonAt), rule);
    }
  }
  window.__validateCalls = 0;
  return {
    validateCell: ({ columnId, value }) => {
      window.__validateCalls = (window.__validateCalls ?? 0) + 1;
      return byColumn.get(columnId)?.(value) ?? null;
    },
  };
}
