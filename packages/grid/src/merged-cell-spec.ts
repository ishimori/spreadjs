// DD-064: 表示のための結合（view-local・consumer の指定・読むだけ）の公開型と、指定の形の検査。
//
// 公開型 GridMergedCell は grid 自身が定義する（R7）。本モジュールは Facade の公開宣言の閉包に入るため、内部 package
// （selection・render・types 等）に依存しない（行に張る解決は merged-cells.ts）。契約の正本は doc/DD/DD-064/contract.md §1。

/** 結合する範囲（DD-064・Experimental 0.x）。左上のセルと、そこから下・右へ何行・何列を 1 つにするかで指定する。 */
export interface GridMergedCell {
  /** 左上のセルの行 ID。 */
  readonly rowId: string;
  /** 左上のセルの列 ID。 */
  readonly columnId: string;
  /** 左上の行を含む行数（1 以上の整数・省略は 1）。 */
  readonly rowSpan?: number;
  /** 左上の列を含む列数（1 以上の整数・省略は 1）。 */
  readonly columnSpan?: number;
}

/** 形の検査を通った指定（列は表示 index に解決済み・span は省略を 1 にした値）。 */
export interface MergeSpec {
  readonly rowId: string;
  readonly columnId: string;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly colStart: number;
}

/** 形の誤り（指定の番号＝0 始まり と理由）。 */
export interface MergeSpecIssue {
  readonly position: number;
  readonly reason: string;
}

export interface MergeSpecValidation {
  /** 配列でなかった（何も適用しない）。 */
  readonly notArray: boolean;
  readonly specs: readonly MergeSpec[];
  readonly issues: readonly MergeSpecIssue[];
}

/** mount オプション `mergedCells` の形の誤り（fail-fast・公開 error code=`merged-cells-invalid`）。 */
export class MergedCellsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergedCellsConfigError';
  }
}

function isSpanValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * 形の検査（contract §1.1）。列の並び（columnOrder）と固定列数だけで決まる誤りを見る。行の有無・重なり・固定行の境界は
 * 行の並びが分かるまで判定できないため、ここでは見ない（解決の時に見る）。
 */
export function validateMergedCells(
  raw: unknown,
  columnOrder: readonly string[],
  frozenColCount: number,
): MergeSpecValidation {
  if (raw === undefined) {
    return { notArray: false, specs: [], issues: [] };
  }
  if (!Array.isArray(raw)) {
    return { notArray: true, specs: [], issues: [] };
  }
  const columnIndex = new Map<string, number>();
  columnOrder.forEach((columnId, index) => {
    if (!columnIndex.has(columnId)) {
      columnIndex.set(columnId, index);
    }
  });
  const colCount = columnOrder.length;
  const frozen = Math.min(Math.max(frozenColCount, 0), colCount);
  const seen = new Set<string>();
  const specs: MergeSpec[] = [];
  const issues: MergeSpecIssue[] = [];
  (raw as readonly unknown[]).forEach((entry: unknown, position) => {
    const issue = (reason: string): void => {
      issues.push({ position, reason });
    };
    if (typeof entry !== 'object' || entry === null) {
      issue('{ rowId, columnId, rowSpan?, columnSpan? } のオブジェクトではない');
      return;
    }
    const record = entry as { rowId?: unknown; columnId?: unknown; rowSpan?: unknown; columnSpan?: unknown };
    if (typeof record.rowId !== 'string' || record.rowId === '') {
      issue('rowId が空でない文字列ではない');
      return;
    }
    if (typeof record.columnId !== 'string' || record.columnId === '') {
      issue('columnId が空でない文字列ではない');
      return;
    }
    if (record.rowSpan !== undefined && !isSpanValue(record.rowSpan)) {
      issue(`rowSpan は 1 以上の整数（受領: ${String(record.rowSpan)}）`);
      return;
    }
    if (record.columnSpan !== undefined && !isSpanValue(record.columnSpan)) {
      issue(`columnSpan は 1 以上の整数（受領: ${String(record.columnSpan)}）`);
      return;
    }
    const rowSpan = record.rowSpan ?? 1;
    const columnSpan = record.columnSpan ?? 1;
    if (rowSpan === 1 && columnSpan === 1) {
      issue('1×1 の範囲（結合ではない）');
      return;
    }
    const colStart = columnIndex.get(record.columnId);
    if (colStart === undefined) {
      issue(`未知の列 ${record.columnId}`);
      return;
    }
    if (colStart + columnSpan > colCount) {
      issue(`列の範囲が右端の列を越える（${record.columnId} から ${columnSpan} 列）`);
      return;
    }
    if (colStart < frozen && colStart + columnSpan > frozen) {
      issue(`固定列（frozenColumnCount=${frozen}）の境界をまたぐ`);
      return;
    }
    const key = `${record.rowId}\u0000${record.columnId}`;
    if (seen.has(key)) {
      issue(`同じ左上（rowId=${record.rowId} columnId=${record.columnId}）の指定が前にある`);
      return;
    }
    seen.add(key);
    specs.push({ rowId: record.rowId, columnId: record.columnId, rowSpan, columnSpan, colStart });
  });
  return { notArray: false, specs, issues };
}

/** 形の誤りの一覧を 1 行の文に（診断・error の message 用）。 */
export function describeMergeIssues(issues: readonly MergeSpecIssue[]): string {
  return issues.map((issue) => `mergedCells[${issue.position}]: ${issue.reason}`).join(' / ');
}
