// @vitest-environment jsdom
// DD-065: 候補欄（mount/select-wiring.ts）と日付カレンダー（mount/date-wiring.ts）の開閉条件を、grid を mount せずに確かめる。
import { afterEach, describe, expect, it } from 'vitest';
import { applyOperation, createDocument } from '@nanairo-sheet/core';
import type { SetCellsOperation } from '@nanairo-sheet/core';
import { createColumnId, createRowId } from '@nanairo-sheet/types';

import { compileAppearance } from '../appearance';
import { createColumnTypeRegistry } from '../column-types';
import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import type { CellValidationSource } from './constants';
import { createDateWiring } from './date-wiring';
import { createSelectWiring } from './select-wiring';

afterEach(() => document.body.replaceChildren());

const COLUMNS = ['c-sel', 'c-date', 'c-icon', 'c-text'];

interface Env {
  readOnly: boolean;
  activeReadOnly: boolean;
  composing: boolean;
  phase: string;
  active: { row: number; col: number };
}

function setup(columnTypes: Parameters<typeof createColumnTypeRegistry>[0] = {
  'c-sel': { type: 'select', options: ['A', 'B'] },
  'c-date': { type: 'date' },
  'c-icon': { type: 'date', openOn: 'icon' },
}) {
  const env: Env = { readOnly: false, activeReadOnly: false, composing: false, phase: 'Navigation', active: { row: 0, col: 0 } };
  const diagnostics: GridDiagnostic[] = [];
  const submitted: Array<{ op: SetCellsOperation; source: CellValidationSource }> = [];
  const calls: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const registry = createColumnTypeRegistry(columnTypes, COLUMNS);
  // 確定の前に「対象の行がまだあるか」を確かめるため、文書に行 r1 を入れておく。
  const doc = applyOperation(
    createDocument(COLUMNS.map((c) => createColumnId(c))),
    { type: 'insertRows', afterRowId: null, rows: [{ rowId: createRowId('r1') }] },
    { revision: 1 },
  ).document;
  const values = new Map<string, string>([['r1|c-sel', 'A'], ['r1|c-date', '2026-11-08']]);
  const backend = {
    session: { committedDocument: doc },
    view: {
      columnIdAt: (index: number) => (index < COLUMNS.length ? createColumnId(COLUMNS[index]!) : undefined),
      rowIdAt: (index: number) => (index === 0 ? createRowId('r1') : undefined),
      rowIndexOf: () => 0,
      colIndexOf: (id: string) => COLUMNS.indexOf(String(id)),
      cellDisplay: (rowId: string, columnId: string) => values.get(`${String(rowId)}|${String(columnId)}`) ?? '',
      markViewportDirty: () => {},
      markCellDirty: () => {},
    },
  } as unknown as GridBackend;
  const editor = {
    session: {
      getActiveCell: () => env.active,
      isComposing: () => env.composing,
      getPhase: () => env.phase,
      getDraft: () => '',
      handleEvent: () => {},
    },
    focus: () => calls.push('focus'),
  } as unknown as IntegrationEditor;
  const diag = createDiagnosticSink((entry) => diagnostics.push(entry));
  const common = {
    host,
    diag,
    stringColumnStrings: new Set<string>(),
    cellLock: {
      isActiveCellReadOnly: () => env.activeReadOnly,
      readOnlyEntryBlocked: (what: string): ['info', string, string] => ['info', 'readonly-column-blocked', what],
      isReadOnlyColumnIndex: () => false,
    },
    merges: { isMergedCellId: () => false },
    editor: () => editor,
    registry: () => registry,
    isReadOnly: () => env.readOnly,
    ensureActiveCellVisible: () => {},
    currentTransform: () => undefined,
    placementConfig: () => ({ headerWidth: 52, headerHeight: 24, viewportWidth: 800, viewportHeight: 600, frozenRowCount: 1, frozenColCount: 1 }),
    visibleArea: () => ({ width: 800, height: 600 }),
    submitSetCells: (op: SetCellsOperation, source: CellValidationSource) => {
      submitted.push({ op, source });
    },
    notifyRowReject: () => calls.push('notifyRowReject'),
  };
  const select = createSelectWiring({ ...common, appearance: () => compileAppearance(undefined, [], () => true, () => undefined) });
  const date = createDateWiring({ ...common, closeSelect: () => {
    calls.push('closeSelect');
    select.close();
  } });
  return { env, select, date, backend, submitted, calls, codes: () => diagnostics.map((d) => d.code) };
}

describe('mount/select-wiring: 開く条件', () => {
  it('backend へ結線する前は何もしない（開かない・診断も出さない）', () => {
    const { select, codes } = setup();
    select.open();
    expect(select.isOpen()).toBe(false);
    expect(select.isSelectColumnIndex(0)).toBe(false);
    expect(codes()).toEqual([]);
  });

  it('結線後、Navigation の選択式セルで開き、候補を出す', () => {
    const { select, backend } = setup();
    select.attach(backend);
    expect(select.isAttached()).toBe(true);
    expect(select.isSelectColumnIndex(0)).toBe(true);
    expect(select.isSelectColumnIndex(3)).toBe(false);
    select.open();
    expect(select.isOpen()).toBe(true);
    expect(select.options()).toEqual(['A', 'B']);
    select.close();
    expect(select.isOpen()).toBe(false);
  });

  it('読み取り専用・読み取り専用のセル・変換中・編集中は開かない', () => {
    const { select, backend, env, codes } = setup();
    select.attach(backend);
    env.readOnly = true;
    select.open();
    expect(select.isOpen()).toBe(false);
    env.readOnly = false;
    env.activeReadOnly = true;
    select.open();
    expect(select.isOpen()).toBe(false);
    env.activeReadOnly = false;
    env.composing = true;
    select.open();
    expect(select.isOpen()).toBe(false);
    env.composing = false;
    env.phase = 'Editing';
    select.open();
    expect(select.isOpen()).toBe(false);
    expect(codes()).toEqual(['readonly-blocked', 'readonly-column-blocked']);
  });

  it('別の候補を選んで確定すると、開いたセルへ select の経路で送る（同じ値なら送らない）', () => {
    const { select, backend, submitted } = setup();
    select.attach(backend);
    select.open();
    select.confirm(); // 今の値（A）のまま
    expect(submitted).toEqual([]);
    select.open();
    select.highlightNext(); // B
    select.confirm();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.source).toBe('select');
    expect(submitted[0]!.op.changes[0]).toMatchObject({ rowId: 'r1', columnId: 'c-sel', value: { kind: 'string', value: 'B' } });
  });

  it('選択式列が無ければドロップダウンを作らない', () => {
    const { select, backend } = setup({});
    select.attach(backend);
    expect(select.isAttached()).toBe(false);
  });
});

describe('mount/date-wiring: 開く条件', () => {
  it('日付列で開き、開く前に候補欄を閉じる。日付列でなければ開かない', () => {
    const { date, select, backend, env, calls } = setup();
    select.attach(backend);
    date.attach(backend);
    env.active = { row: 0, col: 3 };
    date.open();
    expect(date.isOpen()).toBe(false);
    env.active = { row: 0, col: 1 };
    date.open();
    expect(date.isOpen()).toBe(true);
    expect(calls).toContain('closeSelect');
  });

  it('読み取り専用・変換中は開かない', () => {
    const { date, backend, env, codes } = setup();
    date.attach(backend);
    env.active = { row: 0, col: 1 };
    env.readOnly = true;
    date.open();
    expect(date.isOpen()).toBe(false);
    env.readOnly = false;
    env.composing = true;
    date.open();
    expect(date.isOpen()).toBe(false);
    expect(codes()).toEqual(['readonly-blocked']);
  });

  it('ダブルクリックで開く列は openOn が dblclick の日付列だけ（icon の列は textarea 編集のまま）', () => {
    const { date, backend } = setup();
    expect(date.isDblclickDateColumnIndex(1)).toBe(false); // 結線前
    date.attach(backend);
    expect(date.isDblclickDateColumnIndex(1)).toBe(true);
    expect(date.isDblclickDateColumnIndex(2)).toBe(false);
    expect(date.openOnOf(2)).toBe('icon');
    expect(date.openOnOf(3)).toBeUndefined();
  });

  it('確定は開いたセルへ date の経路で送る（同じ値なら送らない）', () => {
    const { date, backend, env, submitted } = setup();
    date.attach(backend);
    env.active = { row: 0, col: 1 };
    date.open();
    date.confirm('2026-11-08');
    expect(submitted).toEqual([]);
    date.open();
    date.confirm('2026-12-24');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.source).toBe('date');
    expect(submitted[0]!.op.changes[0]).toMatchObject({ rowId: 'r1', columnId: 'c-date' });
  });
});
