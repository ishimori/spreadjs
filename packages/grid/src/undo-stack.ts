// undo-stack（DD-020-3）: 確定単位 Undo/Redo の純ロジック（DOM/backend 非依存＝unit 可能）。
//
// 【方式（親③・protocol 変更なし）】Undo は「補償 SetCells」をクライアントが submit する。文書全体を巻き戻さず、
// 逆値（op 実行前の committed 値）を beforeRevision 付きで書き戻す（計画書 §15.1）。既存 OCC
// （validateSetCells の stale-cell-revision）が「対象セルがその後変更されていない」条件（§15.4）をセル単位で
// 自然に検証し、他者が後続変更していれば**全体 reject**（強制 Undo なし＝R-07 サイレント上書き対策）。
//
// 【逆値の捕捉（本子DD決定）】InverseSeed（apply 戻り値）は使わず、**確定単位 chokepoint（mount-controller の
// submitSetCells）で submit 直前に committed から前値を読む**（両モード同一経路・単純）。呼び出し側が UndoPatch を
// 組んで recordUserOp へ渡す。
//
// 【beforeRevision の正しさ（最重要・R-07）】補償 op の beforeRevision は「元操作確定時 revision」を素直に凍結
// するのではなく、**ownedRevision マップ（＝我々の最後の確定操作がそのセルへ付与した revision）**を使う。理由:
//   - 凍結だと「同一セルを 2 回編集 → 2 回 Undo」で、1 回目の Undo（自分の補償）が revision を bump した結果
//     2 回目の Undo が自傷 reject になる（連続編集 undo の破綻）。ownedRevision は自分の補償 ACK で追従するため
//     自傷せず、かつ**他者**の変更（我々が知らない revision）は依然 OCC が弾く（安全性は保つ・シナリオ U-9）。
//   - ownedRevision は「委譲済み ACK の正確な revision」で更新する（committed の事後読取ではない）。同一 echo batch に
//     他者 op が混ざっても、自分の envelope が運ぶ revision を使うので foreign revision を誤って owned にしない。
//
// 【ACK/pending（親⑥）】pending 中（自分の op が未確定）は Undo/Redo 不可＝呼び出し側が `pendingCount===0` を
// 必要条件に渡す。これは「pending op は undo 対象外（AC5）」と「in-flight 補償の直列化（ownedRevision 競合回避）」を
// 同時に満たす。standalone は pendingCount 常に 0・即時確定。
//
// 【拒否時（a）】補償 op が reject されたら該当エントリは**除去**（redo/undo へ戻さない）＋ block 通知
// （undo-blocked / redo-blocked）。元 op（記録直後・未 ACK）の reject はスタックから除去する（AC5: 入らない）。

import type { CellScalar, SetCellsChange, SetCellsOperation } from '@nanairo-sheet/core';
import type { EditPhase } from '@nanairo-sheet/ime';
import type { ColumnId, OperationId, RowId } from '@nanairo-sheet/types';

/** 既定のスタック深さ（親⑥＝100。超過は古い順に破棄）。 */
export const UNDO_STACK_MAX_DEPTH = 100;

/** 1 セルの逆値/順値（undo=before へ復元・redo=after へ再適用）。呼び出し側が chokepoint で committed から組む。 */
export interface UndoPatch {
  readonly rowId: RowId;
  readonly columnId: ColumnId;
  /** op 実行前の committed 値（未書込=blank）。undo で書き戻す。 */
  readonly before: CellScalar;
  /** op が設定した値。redo で再適用する。 */
  readonly after: CellScalar;
}

/** undo/redo スタックの 1 エントリ（1 利用者操作＝1 SetCells）。 */
interface UndoEntry {
  /** 元操作の operationId（collab・未 ACK 中の reject 追跡キー）。ACK/即時確定後・standalone は null。 */
  operationId: OperationId | null;
  readonly patches: readonly UndoPatch[];
}

/** in-flight（submit 済み・未確定）の補償 op の限界情報。undo=redo 行き／redo=undo 行き。 */
interface Limbo {
  readonly direction: 'undo' | 'redo';
  readonly entry: UndoEntry;
  /** 補償 op の operationId（collab・submit 後に設定）。standalone は null（即時解決）。 */
  compensationOpId: OperationId | null;
  /** in-flight 中に新規操作が記録された → 補償確定時に redo 復活を抑止する（undo 方向のみ）。 */
  suppressRedoResurrect: boolean;
}

/** 補償 op の reject 種別（公開 GridConflictCode の undo-blocked/redo-blocked へ写像）。 */
export type CompensationBlock = 'undo-blocked' | 'redo-blocked';

/** beginUndo/beginRedo の結果（submit すべき補償 op）。null=不可（空/pending/in-flight）。 */
export interface CompensationBuild {
  readonly operation: SetCellsOperation;
}

export interface UndoController {
  /**
   * 確定単位 chokepoint で元操作を記録する（redo スタックは破棄＝新規操作・AC4）。
   * @param operationId collab の operationId（reject 追跡）。standalone は null。
   * @param patches 変化のあったセルのみ（before≠after）。空なら記録しない。
   * @param ackedRevision standalone は即時確定 revision（ownedRevision 設定）。collab は null（onCommitted で後追い）。
   */
  recordUserOp(operationId: OperationId | null, patches: readonly UndoPatch[], ackedRevision: number | null): void;
  /**
   * RC4（DD-052-4・Codex P2）: `setRows` 等プログラム的な再注入用。`recordUserOp` と違い redo スタック全体は
   * 破棄しない（無関係な行の Redo 履歴に触れない契約）。ただし今回上書きしたセルを指す redo エントリだけは
   * 個別に取り除く（standalone は OCC 無効＝beforeRevision 未検証のため、残すと redo で古い値へ巻き戻ってしまう）。
   * @param patches 変化のあったセルのみ（before≠after）。空なら記録しない。
   * @param ackedRevision standalone の即時確定 revision（ownedRevision 設定）。
   */
  recordProgrammaticOp(patches: readonly UndoPatch[], ackedRevision: number): void;
  /** collab: own op（元 or 補償）が committed へ確定した（session-sync の own echo 検出）。 */
  onCommitted(operationId: OperationId, revision: number): void;
  /** collab: op が reject された（observer）。補償なら block 種別を返し、元op（未ACK）なら除去して undefined を返す。 */
  onRejected(operationId: OperationId): CompensationBlock | undefined;
  /** Ctrl+Z: 補償 op を生成し in-flight にする。不可（空/pending/in-flight）なら null。 */
  beginUndo(pendingCount: number): CompensationBuild | null;
  /** Ctrl+Y/Ctrl+Shift+Z: 補償 op を生成し in-flight にする。 */
  beginRedo(pendingCount: number): CompensationBuild | null;
  /** collab: 補償 op を submit した直後に operationId を紐づける。 */
  setCompensationOperationId(operationId: OperationId): void;
  /** standalone/collab: in-flight 補償が revision で確定 → エントリを反対スタックへ移し ownedRevision 更新。 */
  resolveCompensationCommitted(revision: number): void;
  /** 補償 submit が失敗（collab で opId 取得不可等）→ in-flight を元スタックへ巻き戻す。 */
  abortInFlightCompensation(): void;
  /**
   * in-flight 補償を**拒否確定**する（エントリ除去＝既定案 a）。submit 前ローカル OCC 検査で stale と判明した場合に使う
   * （opId 紐づけ前に submitLocalOperation が同期 reject して observer が拾えない問題の回避・Codex P1）。block 種別を返す。
   */
  blockInFlightCompensation(): CompensationBlock | undefined;
  /** スタック・ownedRevision・in-flight を全消去する（standalone の文書差し替え＝setData で履歴が無効になるとき・Codex P1）。 */
  clear(): void;
  canUndo(pendingCount: number): boolean;
  canRedo(pendingCount: number): boolean;
  undoDepth(): number;
  redoDepth(): number;
  isBusy(): boolean;
}

function cellKey(rowId: RowId, columnId: ColumnId): string {
  return `${String(rowId)}\u0000${String(columnId)}`;
}

/** CellScalar の値等価（before===after のセルは補償不要＝記録しない・noop 補償のハング防止）。 */
function scalarsEqual(a: CellScalar, b: CellScalar): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'blank') {
    return true;
  }
  return (a as { value: unknown }).value === (b as { value: unknown }).value;
}

function sameOperationId(a: OperationId | null, b: OperationId): boolean {
  return a !== null && String(a) === String(b);
}

/** 補償 SetCells を組む（undo=before・redo=after／beforeRevision=ownedRevision＝OCC の要）。 */
function buildCompensation(
  entry: UndoEntry,
  direction: 'undo' | 'redo',
  ownedRevision: Map<string, number>,
): SetCellsOperation {
  const changes: SetCellsChange[] = entry.patches.map((p) => ({
    rowId: p.rowId,
    columnId: p.columnId,
    beforeRevision: ownedRevision.get(cellKey(p.rowId, p.columnId)) ?? 0,
    value: direction === 'undo' ? p.before : p.after,
  }));
  return { type: 'setCells', conflictPolicy: 'reject-overlap', changes };
}

export function createUndoController(maxDepth: number = UNDO_STACK_MAX_DEPTH): UndoController {
  const undoStack: UndoEntry[] = [];
  const redoStack: UndoEntry[] = [];
  // ownedRevision[cell] = 我々の最後の確定操作（元/補償）がそのセルへ付与した revision。補償の beforeRevision に使う。
  const ownedRevision = new Map<string, number>();
  let limbo: Limbo | null = null;

  /** 元 op（undo/redo スタック内）を ACK 済みにする＝対象セルの ownedRevision を revision へ（operationId は消費）。 */
  function markEntryAcked(operationId: OperationId, revision: number): void {
    for (const stack of [undoStack, redoStack]) {
      for (const entry of stack) {
        if (sameOperationId(entry.operationId, operationId)) {
          for (const p of entry.patches) {
            ownedRevision.set(cellKey(p.rowId, p.columnId), revision);
          }
          entry.operationId = null; // 消費（重複 ACK/事後 reject が誤マッチしない）
          return;
        }
      }
    }
  }

  /** 元 op（未 ACK・記録直後）の reject → スタックから除去（AC5: reject された操作はスタックに入らない）。 */
  function removeEntryByOperationId(operationId: OperationId): void {
    for (const stack of [undoStack, redoStack]) {
      const index = stack.findIndex((e) => sameOperationId(e.operationId, operationId));
      if (index !== -1) {
        stack.splice(index, 1);
        return;
      }
    }
  }

  function updateOwnedRevisionForEntry(entry: UndoEntry, revision: number): void {
    for (const p of entry.patches) {
      ownedRevision.set(cellKey(p.rowId, p.columnId), revision);
    }
  }

  function resolveCommitted(revision: number): void {
    if (limbo === null) {
      return;
    }
    const l = limbo;
    limbo = null;
    updateOwnedRevisionForEntry(l.entry, revision); // 補償が付与した revision を追従（連続 undo の自傷回避・U-9）
    if (l.direction === 'undo') {
      // Undo 成功 → redo スタックへ（新規操作が割り込んでいたら復活させない＝AC4 整合）。
      if (!l.suppressRedoResurrect) {
        redoStack.push(l.entry);
      }
    } else {
      // Redo 成功 → undo スタックへ戻す。
      undoStack.push(l.entry);
      if (undoStack.length > maxDepth) {
        undoStack.shift();
      }
    }
  }

  return {
    recordUserOp(operationId, patches, ackedRevision) {
      // 変化のあったセルのみ保持（before===after は補償不要）。全て変化なしなら記録しない（noop 補償のハング防止）。
      const changed = patches.filter((p) => !scalarsEqual(p.before, p.after));
      if (changed.length === 0) {
        return;
      }
      const entry: UndoEntry = { operationId, patches: changed };
      undoStack.push(entry);
      if (undoStack.length > maxDepth) {
        undoStack.shift(); // 古い順に破棄（AC6）
      }
      // 新規通常操作で redo スタック破棄（AC4）。in-flight の undo 補償があれば redo 復活も抑止する。
      redoStack.length = 0;
      if (limbo !== null && limbo.direction === 'undo') {
        limbo.suppressRedoResurrect = true;
      }
      if (ackedRevision !== null) {
        updateOwnedRevisionForEntry(entry, ackedRevision); // standalone は即時確定
        entry.operationId = null;
      }
    },

    recordProgrammaticOp(patches, ackedRevision) {
      const changed = patches.filter((p) => !scalarsEqual(p.before, p.after));
      if (changed.length === 0) {
        return;
      }
      const entry: UndoEntry = { operationId: null, patches: changed };
      undoStack.push(entry);
      if (undoStack.length > maxDepth) {
        undoStack.shift();
      }
      // redo スタックは全破棄しない（recordUserOp と違う点）。今回上書きしたセルと重なるエントリだけを外す。
      const touched = new Set(changed.map((p) => cellKey(p.rowId, p.columnId)));
      for (let i = redoStack.length - 1; i >= 0; i -= 1) {
        if (redoStack[i]!.patches.some((p) => touched.has(cellKey(p.rowId, p.columnId)))) {
          redoStack.splice(i, 1);
        }
      }
      updateOwnedRevisionForEntry(entry, ackedRevision);
    },

    onCommitted(operationId, revision) {
      if (limbo !== null && sameOperationId(limbo.compensationOpId, operationId)) {
        resolveCommitted(revision); // 補償 op の確定
        return;
      }
      markEntryAcked(operationId, revision); // 元 op の ACK（ownedRevision 設定）
    },

    onRejected(operationId) {
      if (limbo !== null && sameOperationId(limbo.compensationOpId, operationId)) {
        const direction = limbo.direction;
        limbo = null; // 補償 reject（既定案 a）→ エントリ除去（redo/undo へ戻さない）
        return direction === 'undo' ? 'undo-blocked' : 'redo-blocked';
      }
      removeEntryByOperationId(operationId); // 元 op（未 ACK）の reject → 除去（AC5）
      return undefined;
    },

    beginUndo(pendingCount) {
      if (limbo !== null || pendingCount !== 0 || undoStack.length === 0) {
        return null;
      }
      const entry = undoStack.pop()!;
      limbo = { direction: 'undo', entry, compensationOpId: null, suppressRedoResurrect: false };
      return { operation: buildCompensation(entry, 'undo', ownedRevision) };
    },

    beginRedo(pendingCount) {
      if (limbo !== null || pendingCount !== 0 || redoStack.length === 0) {
        return null;
      }
      const entry = redoStack.pop()!;
      limbo = { direction: 'redo', entry, compensationOpId: null, suppressRedoResurrect: false };
      return { operation: buildCompensation(entry, 'redo', ownedRevision) };
    },

    setCompensationOperationId(operationId) {
      if (limbo !== null) {
        limbo.compensationOpId = operationId;
      }
    },

    resolveCompensationCommitted(revision) {
      resolveCommitted(revision);
    },

    abortInFlightCompensation() {
      if (limbo === null) {
        return;
      }
      const l = limbo;
      limbo = null;
      if (l.direction === 'undo') {
        undoStack.push(l.entry); // pop を巻き戻す
      } else {
        redoStack.push(l.entry);
      }
    },

    blockInFlightCompensation() {
      if (limbo === null) {
        return undefined;
      }
      const direction = limbo.direction;
      limbo = null; // エントリ除去（redo/undo へ戻さない・既定案 a）
      return direction === 'undo' ? 'undo-blocked' : 'redo-blocked';
    },

    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      ownedRevision.clear();
      limbo = null;
    },

    canUndo(pendingCount) {
      return limbo === null && pendingCount === 0 && undoStack.length > 0;
    },
    canRedo(pendingCount) {
      return limbo === null && pendingCount === 0 && redoStack.length > 0;
    },
    undoDepth: () => undoStack.length,
    redoDepth: () => redoStack.length,
    isBusy: () => limbo !== null,
  };
}

// ---- keydown 前段裁定（純関数・decideNavigationIntercept と同じ位置で評価する） --------------------

export interface UndoRedoKeyInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** DOM の KeyboardEvent.isComposing。 */
  readonly eventComposing: boolean;
  /** 状態機械の内部 composing（I-2: DOM と内部の両方を見る）。 */
  readonly sessionComposing: boolean;
  readonly phase: EditPhase;
}

export type UndoRedoKeyDecision = 'undo' | 'redo' | 'none';

/**
 * Ctrl/Cmd+Z=Undo・Ctrl+Y/Ctrl+Shift+Z/Cmd+Shift+Z=Redo（親 (b)）。
 * **Navigation 位相かつ非 composing のみ**グリッド裁定。Editing/Composing・composing 中は必ず 'none'
 * （＝ブラウザ既定＝textarea 内テキスト undo へ委譲・I-3）。alt 併用・修飾なしも 'none'。
 */
export function decideUndoRedoKey(input: UndoRedoKeyInput): UndoRedoKeyDecision {
  if (input.eventComposing || input.sessionComposing || input.phase !== 'Navigation' || input.altKey) {
    return 'none';
  }
  const mod = input.ctrlKey || input.metaKey;
  if (!mod) {
    return 'none';
  }
  const key = input.key.toLowerCase();
  if (key === 'z') {
    return input.shiftKey ? 'redo' : 'undo'; // Ctrl/Cmd+Z / Ctrl+Shift+Z / Cmd+Shift+Z
  }
  if (key === 'y' && input.ctrlKey && !input.shiftKey) {
    return 'redo'; // Ctrl+Y（Windows redo）。Cmd+Y は redo にしない（Mac 慣習外）
  }
  return 'none';
}
