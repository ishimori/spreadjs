// DD-047: 公開Facadeと配布tarballだけでReact/grid・両モードを検証するconsumer例。
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { NanairoSheetView, type NanairoSheetViewProps } from '@nanairo-sheet/react';
import { mount, type GridBorder, type GridMountOptions, type GridEvent } from '@nanairo-sheet/grid';

export async function mountBorderExample(container: HTMLElement, params: URLSearchParams): Promise<void> {
  const serverUrl = params.get('server') ?? 'http://127.0.0.1:8791';
  const standalone = params.get('mode') === 'standalone';
  const status = document.getElementById('status');
  if (standalone && status !== null) status.textContent = 'standalone';
  const columnOrder: string[] = standalone ? ['month-date', 'month-quantity', 'next-date', 'next-quantity'] : (await (await fetch(`${serverUrl}/config`)).json() as { columnOrder: string[] }).columnOrder;
  const line: GridBorder = { color: '#64748b', width: 2 };
  const totalRowId = standalone ? 'r5' : 'row-6';
  const onEvent = (event: GridEvent): void => {
    const status = document.getElementById('status');
    if (status !== null && event.type === 'connection') status.textContent = event.state;
    if (status !== null && event.type === 'error') status.textContent = `error: ${event.code}`;
  };
  const common = {
    frozenRowCount: 1, frozenColumnCount: 1,
    columnBorders: { [columnOrder[1]!]: { right: line } },
    rowBorders: { [totalRowId]: { top: line, bottom: line } },
    rowBackgrounds: { [totalRowId]: '#e2e8f0' }, onEvent,
  };
  const options: GridMountOptions = standalone ? {
    ...common, mode: 'standalone', columnOrder,
    initialData: { rows: Array.from({ length: 10 }, (_, i) => ({ rowId: `r${i}`, cells: { [columnOrder[0]!]: `明細${i}` } })) },
  } : { ...common, serverUrl, displayName: 'tarball-border-consumer' };
  if (params.get('facade') === 'react') {
    const props: NanairoSheetViewProps = { ...options, style: { width: '100%', height: '100%' } };
    createRoot(container).render(createElement(NanairoSheetView, props));
  } else mount({ container }, options);
}
