// grid Facade の安定エラーコード語彙（Experimental 0.x・ADR-0015）。
//
// 内部 protocol の RejectCode / 内部文字列を consumer へ素通ししない（R7）。公開語彙へ写像し、未知コードは
// 'unknown' フォールバックで前方互換を保つ（内部 RejectCode の追加で consumer の分岐が壊れない）。破壊的変更は
// CHANGELOG に記録する（S1-5・ADR-0015 D1）。本ファイルは DOM/内部 package 非依存で単体テスト可能に保つ。

/** error イベント（boot/transport 失敗）の安定コード。phase と対で consumer の障害切り分けに使う。 */
export const GRID_ERROR_CODES = [
  'config-unavailable', // /config 取得に失敗（ネットワーク/HTTP エラー・config phase）
  'config-invalid', // /config の形式が不正（config phase）
  'connect-failed', // 初回 WS 接続の確立に失敗（connect phase）
  'runtime-fault', // 配線後の予期しない実行時例外（runtime phase）
  'standalone-options-conflict', // 単独モードに server 系 options（serverUrl/displayName/clientId）を混在指定（config phase・DD-024）
  'standalone-options-invalid', // 単独モードで columnOrder が未指定/空（config phase・DD-024）
  'column-types-invalid', // columnTypes/columnFormats mount オプションが不正（未知列・候補0件・重複・未対応 type〔DD-027-1〕・リンク×wrap 併用〔DD-027-2〕・空ルール配列/match 重複〔DD-027-3〕）→ fail-fast（config phase）
  'column-display-invalid', // columnCaptions/columnDisplayFormats mount オプションが不正（未知列・空/空白キャプション・不正 type・decimals 非整数/0〜20外・pattern 空/既知トークン皆無・wrap 併用・link 併用〔DD-033-2〕）→ fail-fast（config phase）
] as const;
export type GridErrorCode = (typeof GRID_ERROR_CODES)[number];

/**
 * rejected イベントの安定コード。server 競合（内部 RejectCode / ConflictReason の写像）に加え、
 * クライアントが submit 前に拒否する実行前検査（range-too-large 等・DD-020-1）も同じ語彙で通知する
 * （実行前拒否は operationId が空文字＝submit されていない）。
 */
export const GRID_CONFLICT_CODES = [
  'cell-conflict', // 同一セルの同時編集競合（stale-cell-revision）
  'row-unavailable', // 対象行が存在しない/削除済み（target-row-deleted / unknown-row / unknown-anchor）
  'column-unavailable', // 対象列が存在しない（unknown-column）
  'revision-stale', // ベースリビジョン不整合（invalid-base-revision）
  'sequence-violation', // クライアント連番違反（client-sequence-violation）
  'duplicate-row', // 行 ID 重複（duplicate-row）
  'revalidation-failed', // ローカル再検証に失敗（reason=revalidation-failed）
  'dependency', // 依存 Op の失敗に連鎖して不成立（reason=dependency）
  'range-too-large', // 範囲操作（範囲クリア等）のセル数が SetCells 上限（100,000）超過→実行前拒否（DD-020-1・submit なし）
  'paste-too-large', // 貼り付け矩形のセル数が SetCells 上限（100,000）超過→実行前拒否（DD-020-2・submit なし）
  'paste-out-of-bounds', // 貼り付け矩形が行/列端を越える→全体拒否（切り捨てず・DD-020-2・submit なし）
  'undo-blocked', // Undo の補償 SetCells が OCC（対象セルが他者に後続変更された）で全体 reject（DD-020-3・強制 Undo なし）
  'redo-blocked', // Redo の補償 SetCells が OCC で全体 reject（DD-020-3・対象セルがさらに変更された）
  'row-anchor-unknown', // insertRows の afterRowId が未知アンカー→実行前拒否（DD-021-1・submit なし）
  'row-count-invalid', // insertRows の count が 1 未満/非整数→実行前拒否（DD-021-1・submit なし）
  'row-delete-empty', // deleteRows の対象が空/全て非現存→実行前拒否（DD-021-1・submit なし）
  'value-not-allowed', // 選択式列（allowFreeText:false）へ editor 経路で非候補値を確定→未 submit（DD-027-1・submit なし・拒否値は診断へ）
  'unknown', // 未知/未写像（前方互換フォールバック）
] as const;
export type GridConflictCode = (typeof GRID_CONFLICT_CODES)[number];

/**
 * boot 失敗を error phase の公開 code 付きで伝える内部エラー。mount-controller の boot が throw し、
 * 呼び出し側が code を error イベントへ載せる（内部 message 文字列からの脆い判定を避ける）。
 */
export class GridBootError extends Error {
  constructor(
    readonly code: GridErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GridBootError';
  }
}

// server RejectCode（core protocol §3）→ 公開 GridConflictCode の写像表。ここに無い code は 'unknown'。
const REJECT_CODE_MAP: Record<string, GridConflictCode> = {
  'stale-cell-revision': 'cell-conflict',
  'target-row-deleted': 'row-unavailable',
  'unknown-row': 'row-unavailable',
  'unknown-anchor': 'row-unavailable',
  'unknown-column': 'column-unavailable',
  'invalid-base-revision': 'revision-stale',
  'client-sequence-violation': 'sequence-violation',
  'duplicate-row': 'duplicate-row',
};

/**
 * 内部 ConflictReason（'rejected' | 'revalidation-failed' | 'dependency'）と server RejectCode 文字列を
 * 公開 GridConflictCode へ写像する。未知 RejectCode は 'unknown'（前方互換）。
 */
export function toGridConflictCode(reason: string, rawCode: string | undefined): GridConflictCode {
  if (reason === 'revalidation-failed') {
    return 'revalidation-failed';
  }
  if (reason === 'dependency') {
    return 'dependency';
  }
  // reason === 'rejected'（server 判定）: RejectCode を公開語彙へ写像する。
  const mapped = rawCode === undefined ? undefined : REJECT_CODE_MAP[rawCode];
  return mapped ?? 'unknown';
}
