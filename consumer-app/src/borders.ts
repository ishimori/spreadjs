// DD-047: 公開Facadeと配布tarballだけでReact/grid・両モードを検証するconsumer例。
import { createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { NanairoSheetView, type NanairoSheetViewProps, type NanairoSheetViewHandle } from '@nanairo-sheet/react';
import { mount, type GridBorder, type GridMountOptions, type GridEvent, type GridInstance } from '@nanairo-sheet/grid';

export async function mountBorderExample(container: HTMLElement, params: URLSearchParams): Promise<void> {
  const serverUrl = params.get('server') ?? 'http://127.0.0.1:8791';
  const standalone = params.get('mode') === 'standalone';
  const status = document.getElementById('status');
  if (standalone && status !== null) status.textContent = 'standalone';
  const columnOrder: string[] = standalone ? ['month-date', 'month-quantity', 'next-date', 'next-quantity'] : (await (await fetch(`${serverUrl}/config`)).json() as { columnOrder: string[] }).columnOrder;
  const line: GridBorder = { color: '#64748b', width: 2 };
  const patterns = params.has('patterns');
  const totalRowId = standalone ? 'r5' : 'row-6';
  let insertedRowId: string | undefined;
  const onEvent = (event: GridEvent): void => {
    if (event.type === 'row-structure-change' && event.change.kind === 'insert') insertedRowId = event.change.rowIds[0];
    const status = document.getElementById('status');
    if (status !== null && event.type === 'connection') status.textContent = event.state;
    if (status !== null && event.type === 'error') status.textContent = `error: ${event.code}`;
  };
  const common = {
    frozenRowCount: 1, frozenColumnCount: 1,
    columnBorders: { [columnOrder[1]!]: { right: line } },
    rowBorders: { [totalRowId]: { top: line, bottom: line } },
    rowBackgrounds: { [totalRowId]: '#e2e8f0' }, onEvent,
    ...(patterns ? { defaultRowBorder: { color: '#cbd5e1', width: 1, style: 'dotted' as const } } : {}),
  };
  const options: GridMountOptions = standalone ? {
    ...common, mode: 'standalone', columnOrder,
    initialData: { rows: Array.from({ length: 10 }, (_, i) => ({ rowId: `r${i}`, cells: { [columnOrder[0]!]: `明細${i}` } })) },
  } : { ...common, serverUrl, displayName: 'tarball-border-consumer' };
  const ref = createRef<NanairoSheetViewHandle>();
  let instance: GridInstance | undefined;
  let rerender = (): void => {};
  if (params.get('facade') === 'react') {
    const props: NanairoSheetViewProps = { ...options, style: { width: '100%', height: '100%' } };
    const root = createRoot(container);
    rerender = () => root.render(createElement(NanairoSheetView, { ...props, ref, ...(props.defaultRowBorder === undefined ? {} : { defaultRowBorder: { ...props.defaultRowBorder } }) }));
    rerender();
  } else instance = mount({ container }, options);
  if (patterns) {
    const controls = document.createElement('div');
    controls.style.cssText = 'position:absolute;right:8px;top:2px;display:flex;gap:8px';
    document.body.append(controls);
    for (const [label, action] of [
      ['行を追加', () => (instance ?? ref.current)?.insertRows({ afterRowId: standalone ? 'r0' : 'row-1' })],
      ['同値で再描画', rerender],
      ['追加行を削除', () => { if (insertedRowId !== undefined) (instance ?? ref.current)?.deleteRows([insertedRowId]); }],
      ...(standalone ? [['データを差し替え', () => (instance ?? ref.current)?.setData({ rows: [{ rowId: 'new-id', cells: { [columnOrder[0]!]: '差し替え' } }] })] as const] : []),
    ] as const) {
      const button = document.createElement('button'); button.textContent = label; button.onclick = action;
      controls.append(button);
    }
  }
}
