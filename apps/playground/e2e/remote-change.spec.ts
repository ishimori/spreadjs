// DD-049 E2E（contract.md §3・§4・§7 E1〜E3）: 共同編集の確定変更イベント（remote-change）と参加者一覧（presence）を
// 実ブラウザーの 2 クライアント（別コンテキスト＝別ユーザー）で確認する。
//   E1 B の確定 → A に origin=remote・actorId=B の userId・前後値付きで届き、値は A の committed と一致。B 自身には origin=local。
//   E3 B の参加・セル移動・切断が A の presence イベントに順に反映され、presences() と最後のイベントが一致。自分は先頭で self=true。
//   E2 単独ページでは確定で cell-commit が出るが remote-change / presence は出ず、presences() は []。
// 共有 WS 文書（demo-doc・50,000 行）は直列の全 collab spec が共有するため、行 index は実行時に RowId を引き、
// 書き込む値と表示名は実行ごとに一意にする（DD-048 の分離方針）。

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import * as ih from './integration-helpers';
import * as sh from './standalone-helpers';

test.describe.configure({ mode: 'serial' });

interface PresenceUserView {
  userId: string;
  displayName: string;
  activeCell: { rowId: string; columnId: string } | null;
  self: boolean;
}

interface RemoteChangeView {
  origin: string;
  revision: number;
  actorId: string;
  changes: Array<{ rowId: string; columnId: string; value: string; previousValue: string }>;
}

/** DD-049 証跡の保存先（test-results/dd-evidence/DD-049/・確定した証跡は doc/DD/DD-049/ へ手でコピーする）。 */
function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-049/${fileName}`, import.meta.url));
}

/** main.ts が記録した GridEvent（window.__gridEvents）から remote-change の change だけを取り出す。 */
async function remoteChanges(page: Page): Promise<RemoteChangeView[]> {
  return page.evaluate(() => {
    const events = (window as unknown as { __gridEvents?: Array<{ type: string; change?: unknown }> }).__gridEvents ?? [];
    return events.filter((e) => e.type === 'remote-change').map((e) => e.change) as RemoteChangeView[];
  });
}

/** presence イベントの users 列と、同じ瞬間の GridInstance.presences()（同一 JS タスク内で読む）。 */
async function presenceState(page: Page): Promise<{ events: PresenceUserView[][]; current: PresenceUserView[] }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __gridEvents?: Array<{ type: string; users?: unknown }>;
      __gridInstance?: { presences(): unknown };
    };
    const events = (w.__gridEvents ?? []).filter((e) => e.type === 'presence').map((e) => e.users) as PresenceUserView[][];
    const current = (w.__gridInstance?.presences() ?? []) as PresenceUserView[];
    return { events, current };
  });
}

test('DD-049: B の確定が A（remote）と B 自身（local）の remote-change に届き、参加者一覧に参加・移動・切断が順に反映される', async ({
  browser,
}) => {
  const suffix = Date.now().toString(36);
  const aliceName = `Alice-${suffix}`;
  const bobName = `Bob-${suffix}`;
  const a = await ih.openClient(browser, aliceName, { activity: '1' });
  const b = await ih.openClient(browser, bobName, { activity: '1' });
  let bobClosed = false;
  try {
    // 自分は先頭・self=true（初回 join 後に載る）。
    await expect
      .poll(async () => (await presenceState(a.page)).current[0], { message: 'A の presences() 先頭が自分' })
      .toMatchObject({ displayName: aliceName, self: true });

    // B がセルを選ぶ → A の参加者一覧に B のアクティブセルが載る（RowId/ColumnId は実行時に引く）。
    const rowId = await ih.rowIdAt(b.page, 3);
    const columnId = await ih.colIdAt(b.page, 2);
    expect(rowId).toBeDefined();
    expect(columnId).toBeDefined();
    await ih.selectCell(b.page, 3, 2);
    await expect
      .poll(async () => (await presenceState(a.page)).current.find((u) => u.displayName === bobName)?.activeCell ?? null, {
        message: 'A の presences() に B のアクティブセル',
      })
      .toEqual({ rowId, columnId });
    const afterMove = await presenceState(a.page);
    expect(afterMove.events[afterMove.events.length - 1], '最後の presence イベント＝presences() の現在値').toEqual(
      afterMove.current,
    );
    const bobEntry = afterMove.current.find((u) => u.displayName === bobName);
    expect(bobEntry?.self).toBe(false);
    expect(afterMove.current.filter((u) => u.self)).toHaveLength(1);

    // B が一意な値を確定する → A に origin=remote・actorId=B の userId・前後値付きで 1 回届く。
    const previousValue = await ih.committedCell(a.page, rowId!, columnId!);
    const value = `rc-${suffix}`;
    await ih.plainTypeAndCommit(b.page, value);
    await expect.poll(async () => ih.committedCell(a.page, rowId!, columnId!), { message: 'A の committed に B の値' }).toBe(value);
    await expect
      .poll(async () => (await remoteChanges(a.page)).filter((c) => c.changes.some((x) => x.value === value)).length, {
        message: 'A に remote-change が届く',
      })
      .toBe(1);
    const onAlice = (await remoteChanges(a.page)).find((c) => c.changes.some((x) => x.value === value));
    expect(onAlice).toMatchObject({ origin: 'remote', actorId: bobEntry?.userId });
    expect(onAlice?.changes).toEqual([{ rowId, columnId, value, previousValue }]);
    expect(onAlice?.changes[0]?.value).toBe(await ih.committedCell(a.page, rowId!, columnId!));

    // B 自身にはサーバー確定後に origin=local で届き、revision は A と同じ。
    await expect
      .poll(async () => (await remoteChanges(b.page)).filter((c) => c.changes.some((x) => x.value === value)).map((c) => c.origin), {
        message: 'B に origin=local の remote-change が届く',
      })
      .toEqual(['local']);
    const onBob = (await remoteChanges(b.page)).find((c) => c.changes.some((x) => x.value === value));
    expect(onBob?.revision).toBe(onAlice?.revision);

    // 証跡: A の画面（?activity=1 の参加者一覧・確定変更の表示）を赤枠で強調して撮る。
    await expect(a.page.locator('#int-activity')).toContainText(bobName);
    await expect(a.page.locator('#int-activity')).toContainText(value);
    await ih.highlightSelector(a.page, '#int-activity');
    await a.page.screenshot({ path: evidencePath('dd049-alice-remote-change-presence.png') });

    // B が閉じる → A の参加者一覧から消える（切断は即時）。
    await b.context.close();
    bobClosed = true;
    await expect
      .poll(async () => (await presenceState(a.page)).current.some((u) => u.displayName === bobName), {
        message: 'B の切断が A の参加者一覧に反映',
      })
      .toBe(false);
    const final = await presenceState(a.page);
    expect(final.events[final.events.length - 1]).toEqual(final.current);
    // 順序: B がアクティブセル付きで現れたイベントの後に、B が消えたイベントが来る。
    const movedAt = final.events.findIndex((users) =>
      users.some((u) => u.displayName === bobName && u.activeCell?.rowId === rowId && u.activeCell?.columnId === columnId),
    );
    const goneAt = final.events.findIndex((users, index) => index > movedAt && !users.some((u) => u.displayName === bobName));
    expect(movedAt).toBeGreaterThanOrEqual(0);
    expect(goneAt).toBeGreaterThan(movedAt);
    await a.page.screenshot({ path: evidencePath('dd049-alice-after-bob-closed.png') });
  } finally {
    if (!bobClosed) {
      await b.context.close();
    }
    await a.context.close();
  }
});

test('DD-049: 単独ページでは確定で cell-commit が出るが remote-change / presence は出ず、presences() は空', async ({ browser }) => {
  const s = await sh.openStandalone(browser);
  try {
    await sh.composeCommitAtCell(s.page, 1, 1, 'DD049');
    await expect
      .poll(async () => (await sh.events(s.page)).some((e) => e.type === 'cell-commit'), { message: 'cell-commit' })
      .toBe(true);
    const types = (await sh.events(s.page)).map((e) => e.type);
    expect(types).not.toContain('remote-change');
    expect(types).not.toContain('presence');
    const presences = await s.page.evaluate(
      () => (window as unknown as { __gridInstance?: { presences(): unknown } }).__gridInstance?.presences() ?? null,
    );
    expect(presences).toEqual([]);
  } finally {
    await s.context.close();
  }
});
