// GridBackend（DD-024）: mount-controller が値の源として依存する最小 interface。
//
// 共同編集モードの SessionSync（ClientSession + DocumentView）と、単独モードの StandaloneSession が
// 共通で満たす。mount-controller の rendering/IME 配線（baseLayer・docPort・editor・rAF）は本 interface
// だけに依存し、「どの backend を作るか」の分岐を backend 生成部へ閉じる。
//
// SessionSync は本 interface を構造的に満たす（session=ClientSession は下記の公開メンバの上位集合）。
// 単独モードは connection/presence/heartbeat を持たないため、session 面は trivial 実装（no-op/空値）を返す。

import type { DocumentOperation, SheetDocument, UserPresence } from '@nanairo-sheet/core';
import type { OperationId } from '@nanairo-sheet/types';
import type { PresenceUpdate } from '@nanairo-sheet/collab';

import type { DocumentView } from './document-view';

/**
 * mount-controller が backend の「session（Document State の源）」へ求める最小契約。
 * ClientSession（共同編集）の公開メンバ部分集合。単独モードは以下を trivial 実装する。
 */
export interface GridBackendSession {
  /** ローカル Operation を適用する（共同編集=楽観適用→pending・単独=document へ即適用）。 */
  submitLocalOperation(operation: DocumentOperation): OperationId | void;
  /** 権威文書（IME の startRevision/生存/staleness 判定に使う）。 */
  readonly committedDocument: SheetDocument;
  /**
   * 表示文書（committed＋own pending の楽観適用結果・単独=committed と同一）。DD-020-3 Undo は逆値（前値）を
   * ここから捕捉する（未 ACK の先行編集を飛ばさないため＝committed だけだと直前の楽観編集値を失う）。
   */
  readonly viewDocument: SheetDocument;
  /**
   * 未 ACK の pending operationId 一覧（単独=空）。DD-020-3 Undo は submit が同期 reject された op を
   * undo エントリへ誤記録しないため、submit 後に返り値 opId が pending に残ったか確認する。
   */
  pendingOperationIds(): readonly OperationId[];
  /** 既知の他者 Presence（単独モードは空配列）。 */
  knownPresences(): readonly UserPresence[];
  /** 自分の Presence を送る（単独モードは no-op）。 */
  sendPresence(update: PresenceUpdate): void;
  /** 再送/catch-up ポーリング（単独モードは no-op）。 */
  tick(): void;
  /** 生存通知（単独モードは no-op）。 */
  sendHeartbeat(): void;
  /** オンライン（単独モードは false）。 */
  readonly isOnline: boolean;
  /**
   * サーバーの初回の状態を受け取ったか（DD-070-5・共同編集だけ持つ。一度 true になったら戻らない）。false の間の view は
   * サーバーの既存の行を欠くので、getRows は空を返す。単独モードは持たない（常に読める）。
   */
  readonly hasInitialState?: boolean;
  /** 編集停止（divergence 等・単独モードは false）。 */
  readonly isStopped: boolean;
  /** 未送信 pending 件数（単独モードは 0）。 */
  readonly pendingCount: number;
  /** 競合キュー（length のみ参照・単独モードは空）。 */
  readonly conflictQueue: readonly unknown[];
  /** snapshot bootstrap の revision（単独モードは undefined/0）。 */
  readonly bootstrapRevision: number | undefined;
  /** 適用済みサーバー op 総数（単独モードは 0）。 */
  readonly appliedServerOpCount: number;
}

/** mount-controller が依存する backend（view=描画アダプター / session=Document State 源 / start=起動）。 */
export interface GridBackend {
  readonly view: DocumentView;
  readonly session: GridBackendSession;
  /** 起動（共同編集=transport.connect→join・単独=初期データ確定）。 */
  start(): void;
}
