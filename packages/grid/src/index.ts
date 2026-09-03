// @nanairo-sheet/grid — Canvas 描画グリッドの唯一の公開面（Facade・Experimental 0.x・ADR-0015）。
//
// consumer は内部パッケージ（core/collab/render/selection/ime/types）を直接 import せず、この Facade だけを
// import する（R1）。mount() が内部パッケージを束ね、container 内に Canvas/scroller/常駐 textarea を構築し、
// 共同編集セッション・IME・仮想スクロール描画を配線する。destroy() で全リソース（listener/RAF/WS/canvas/
// textarea）を解放する（再mountで leak しない）。
//
// 【R7】公開シグネチャに内部パッケージ由来の型を出さない（GridEvent/GridConflict/GridConnectionState は
// 本 Facade が定義する。内部 SessionEvent/ConflictQueueEntry を写像して露出する）。boundary lint が本 index.ts を検査する。

import { createGridController } from './mount-controller';

// 公開エラー語彙・診断 hook は Facade 自前モジュールが定義する（内部 package 型ではない＝R7 に反さない）。
export { GRID_ERROR_CODES, GRID_CONFLICT_CODES } from './error-codes';
export type { GridErrorCode, GridConflictCode } from './error-codes';
export type { GridDiagnostic, GridDiagnosticLevel, GridDiagnosticHook } from './diagnostics';

import type { GridConflictCode, GridErrorCode } from './error-codes';
import type { GridDiagnosticHook } from './diagnostics';

// 列タイプ体系（DD-027-1・Experimental 0.x）。公開型は grid 自身（column-types.ts）で定義する（内部 package 型
// ではない＝R7 に反さない）。registry 本体は Internal で、consumer 向けの登録 API は公開しない（決定⑤）。
export type { GridColumnType, GridSelectColumnType, GridLinkColumnType } from './column-types';
import type { GridColumnType } from './column-types';

// セル書式モデル（DD-027-3・Experimental 0.x）。利用側供給の「値→書式マッピング」による view-local 描画。
// 公開型は grid 自身（format-rules.ts）で定義する（内部 package 型ではない＝R7 に反さない）。
export type { GridColumnFormatRule, GridCellFormatStyle } from './format-rules';
import type { GridColumnFormatRule } from './format-rules';

// 列見出しキャプション＋数値/日付の表示書式（DD-033-2・Experimental 0.x）。Canvas 描画テキストのみを整形する
// view-local 書式（raw 契約不変）。公開型は grid 自身（display-format.ts）で定義する（R7 に反さない）。
export type {
  GridColumnDisplayFormat,
  GridNumberDisplayFormat,
  GridDateDisplayFormat,
} from './display-format';
import type { GridColumnDisplayFormat } from './display-format';

/**
 * 接続状態（consumer 表示用）。内部 collab の ConnectionState を写像した公開型（型は再exportしない）。
 * `'standalone'` は単独グリッドモード（DD-024・共同編集サーバー非接続）で常に返る値。`'offline'` は
 * 「一時切断（再接続中）」を含意するため、恒常的に非接続な単独モードとは区別する。
 */
export type GridConnectionState = 'online' | 'offline' | 'stopped' | 'standalone';

/** reject（競合）の理由。内部 collab の ConflictReason を写像した公開型。 */
export type GridConflictReason = 'rejected' | 'revalidation-failed' | 'dependency';

/**
 * 競合の公開サマリ（R7: 内部 ConflictQueueEntry の DocumentOperation/OperationViolation/RejectDetails は露出しない）。
 * Alpha は「競合の通知」を保証し、プログラム的な競合解決 UI の材料公開は Stage 2。
 */
export interface GridConflict {
  /** 競合したローカル Operation の ID（文字列化）。 */
  readonly operationId: string;
  /** 競合理由。 */
  readonly reason: GridConflictReason;
  /**
   * 安定した公開競合コード（内部 RejectCode を素通しせず公開語彙へ写像＝R7）。未知/未写像は 'unknown'。
   * 一覧は doc/DD/DD-017/error-codes.md を参照（GRID_CONFLICT_CODES）。
   */
  readonly code: GridConflictCode;
}

/**
 * grid が発火する公開イベント（lifecycle 契約: connection state・error notification）。
 * 内部 SessionEvent（connection/pending/rejected/divergence）を写像し、boot/transport 例外を error として整形する。
 */
export type GridEvent =
  | { readonly type: 'connection'; readonly state: GridConnectionState; readonly pendingCount: number }
  | { readonly type: 'pending'; readonly pendingCount: number }
  | { readonly type: 'rejected'; readonly pendingCount: number; readonly conflict: GridConflict }
  | { readonly type: 'divergence'; readonly serverRevision: number; readonly committedRevision: number }
  | {
      readonly type: 'error';
      readonly phase: 'config' | 'connect' | 'runtime';
      /** 安定した公開エラーコード（一覧は doc/DD/DD-017/error-codes.md＝GRID_ERROR_CODES）。 */
      readonly code: GridErrorCode;
      readonly message: string;
    }
  /**
   * レイアウト（列幅・行高）変更の確定通知（Experimental 0.x・DD-012-4 D2）。ヘッダー境界ドラッグの確定時
   * （pointerup）に発火する。columnWidths/rowHeights は **既定値と異なる列/行だけ**を含む（override のみ）。
   * 設定は view-local（他ユーザーへ即時同期しない）。利用側がこれを保存し、次回 mount の columnWidths/rowHeights へ
   * 渡せば F5 リロードで復元できる（共有保存にすれば他ユーザーへも反映）。キーは ColumnId/RowId 文字列。
   */
  | {
      readonly type: 'layout';
      readonly columnWidths: Record<string, number>;
      readonly rowHeights: Record<string, number>;
    }
  /**
   * 確定値の通知（Experimental 0.x・DD-024・**単独グリッドモード専用**）。IME 確定・Delete 等で committed に
   * なった値変更を 1 確定操作 = 1 イベント（SetCells の batch 単位）で通知する。**通知のみ**（grid は書き戻さない・
   * 決定②）。利用側がこれを受けて認証・保存を行い（責務境界＝roadmap §6）、保存失敗時は `setData` 再注入で
   * 見た目を戻す。共同編集モードでは発火しない（確定は既存の pending/connection 経路）。
   */
  | { readonly type: 'cell-commit'; readonly changes: readonly GridCellCommitChange[] }
  /**
   * 行構造変更（Insert/Delete）の確定通知（Experimental 0.x・DD-021-1・**両モード共通**）。利用側が行う
   * ローカル行操作（`insertRows`/`deleteRows`・Excel 準拠ショートカット）の楽観適用時に発火する。
   * **単独グリッドモードでは本イベントが行構造の保存材料**（cell-commit がセル値専用なのに対し、本イベントは
   * 行の増減を伝える）。共同編集モードでも発火するが行構造の永続化はサーバー責務（本イベントは通知のみ・
   * grid は書き戻さない）。他クライアント起因の行構造変更の通知・選択再ベースは後続（DD-021-2/3）。
   */
  | { readonly type: 'row-structure-change'; readonly change: GridRowStructureChange }
  /**
   * ハイパーリンク列（DD-027-2・親③）のクリック通知（Experimental 0.x・両モード共通）。リンク列の非空セルを
   * クリック（押下→同一セルで離す・detail=1）すると発火する。**SDK は navigate しない**（利用側が rowId/columnId/value
   * を受けて SPA 内遷移や詳細表示を実装する＝責務境界）。activeCell 移動は従来どおり並行して起こる（選択を奪わない）。
   * ドラッグ選択・Shift+クリック・キーボード/タッチ・編集/変換中クリックでは発火しない。列の `defaultOpen:true` 時は
   * 本イベントに加えて SDK が絶対 http/https URL を `window.open(value,'_blank','noopener,noreferrer')` で開く
   * （不正 URL は open せず診断 warn・本イベントは常に発火）。rowId/columnId/value は文字列（内部型は露出しない・R7）。
   */
  | { readonly type: 'link-open'; readonly rowId: string; readonly columnId: string; readonly value: string };

/**
 * 行構造変更の内容（DD-021-1）。insert は挿入アンカー（`afterRowId`・null=先頭）と新規 RowId 列（表示順・
 * `crypto.randomUUID` 採番）、delete は削除された RowId 列（実在・重複除去済み）。利用側はこれで行の増減を
 * 再構成できる（RowId は文字列・内部 RowId 型は露出しない・R7）。
 */
export type GridRowStructureChange =
  | { readonly kind: 'insert'; readonly afterRowId: string | null; readonly rowIds: readonly string[] }
  | { readonly kind: 'delete'; readonly rowIds: readonly string[] };

/** cell-commit の 1 セル変更（DD-024）。value/previousValue は表示文字列（内部 CellScalar は露出しない・R7）。 */
export interface GridCellCommitChange {
  readonly rowId: string;
  readonly columnId: string;
  /** 確定後の表示文字列。 */
  readonly value: string;
  /** 確定前の表示文字列。 */
  readonly previousValue: string;
}

export type GridEventListener = (event: GridEvent) => void;

/** 単独グリッドモードの 1 行（DD-024）。cells は ColumnId 文字列→値文字列（未指定列は空セル）。 */
export interface GridStandaloneRow {
  readonly rowId: string;
  readonly cells?: Readonly<Record<string, string>>;
}

/**
 * 単独グリッドモードの初期/再注入データ（DD-024・決定③）。rows は表示順。値は文字列で渡し、内部で
 * parseCellInput により CellScalar（数値/日付/文字列）へ解釈される（cell-commit の value と round-trip する）。
 */
export interface GridStandaloneData {
  readonly rows: readonly GridStandaloneRow[];
}

/** grid をマウントする DOM ターゲット（Facade が container 内部に Canvas/scroller/textarea を構築する）。 */
export interface GridMountTarget {
  readonly container: HTMLElement;
}

/**
 * 両モード共通の mount オプション（Experimental 0.x）。共同編集・単独グリッドの双方で使える描画/購読系。
 */
export interface GridCommonMountOptions {
  /**
   * 初期の列幅 override（ColumnId 文字列→px・Experimental 0.x・DD-012-4 D2）。利用側が保存した設定を
   * 渡すと初期表示がその幅になる（F5 リロードでの復元手段）。既定値でよい列は含めない。
   */
  readonly columnWidths?: Readonly<Record<string, number>>;
  /** 初期の行高 override（RowId 文字列→px・Experimental 0.x・DD-012-4 D2）。 */
  readonly rowHeights?: Readonly<Record<string, number>>;
  /**
   * 折り返し（wrap）列（ColumnId 文字列の配列・Experimental 0.x・DD-012-5 D1）。指定列のセルは
   * はみ出さずセル内で折り返し表示され、折り返しで収まらない行は必要な高さへ自動拡張される（Excel 風・自動行高）。
   * 未指定（既定）の列は、左寄せ文字列が右隣の連続空セルへはみ出して表示される（オーバーフロー・描画のみ）。
   * mount 時に固定（実行時切替は Stage 2）。キーは ColumnId 文字列。
   */
  readonly wrapColumns?: readonly string[];
  /**
   * 列タイプ（ColumnId 文字列→列タイプ・Experimental 0.x・DD-027-1/2）。両モード共通・mount 時固定（wrapColumns と
   * 同運用）。選択式入力列（`{ type: 'select', options, allowFreeText? }`）とハイパーリンク列（`{ type: 'link', defaultOpen? }`）。
   * - **選択式**: 検証は editor 経路（IME/textarea 確定・ドロップダウン）の commit 直前だけ。`allowFreeText:false`（既定）の
   *   選択式列は候補外の値を確定できない（未 submit＋`rejected`（code=`value-not-allowed`）通知＋診断・文書無変更）。
   *   paste / setData / リモート由来の非候補値は検証されず保持・表示される（拒否しない＝データ非破壊・収束優先）。
   * - **リンク**: 値は string 1本。クリックで `link-open` イベントが発火する（**SDK は navigate しない**が既定）。
   *   `defaultOpen:true` のときだけ絶対 http/https URL を `window.open(_,'_blank','noopener,noreferrer')` で開く
   *   （javascript:/data:/相対/非URL は open せず診断 warn・link-open は常に発火）。リンク列は wrapColumns と併用不可。
   * - 不正設定（未知列・候補0件・重複・未対応 type・リンク×wrap 併用）は mount 時に `error`（phase=config・
   *   code=`column-types-invalid`）で fail-fast する。共同編集モードでの全クライアント設定一致は利用側責務（値は string のまま）。
   */
  readonly columnTypes?: Readonly<Record<string, GridColumnType>>;
  /**
   * セル書式ルール（ColumnId 文字列→書式ルール配列・Experimental 0.x・DD-027-3）。両モード共通・mount 時固定
   * （columnTypes と同運用）。利用側供給の「値→書式（背景色・文字色・バッジ）」マッピングによる **view-local 描画**。
   * - **値ベース**: 書式はセルの**表示文字列の完全一致**（v1）で解決され、**非空セルのみ**に付く（空セル・非一致値・
   *   未指定列は現行描画と完全一致）。文書状態（値・hash・snapshot・protocol）は一切変更しない。同じ値なら同じ見た目に
   *   なるため、全クライアントが同じ `columnFormats` を持てば実質同一表示になる（**設定一致は利用側責務**・設定不一致
   *   クライアントは異なる装飾を見る＝共有化の設計方針は doc/plan/cell-format-sharing-design.md）。
   * - **ルール**: `{ match: string | string[], style: { cellBackground?, textColor?, badge?, badgeColor? } }`。
   *   `badge:true` は値を丸角チップで描く（右隣へオーバーフローしない）。範囲/正規表現/callback・静的列色は v1 対象外。
   * - 不正設定（未知列・空ルール配列・同一列内の match 重複）は mount 時に `error`（phase=`config`・
   *   code=`column-types-invalid`）で fail-fast する（columnTypes と同経路）。
   */
  readonly columnFormats?: Readonly<Record<string, readonly GridColumnFormatRule[]>>;
  /**
   * 列見出しキャプション（ColumnId 文字列→表示名・Experimental 0.x・DD-033-2）。両モード共通・mount 時固定
   * （columnTypes/columnFormats と同運用）。指定列はヘッダーの A/B/C… を業務名で置換描画し、自ヘッダーセル幅を
   * 超える長い名は省略記号でクリップされる（隣接ヘッダーへ重ならない）。未指定列・行番号ヘッダーは従来どおり。
   * - **view-local**（描画のみ）: 文書状態・列 ID・cell-commit・コピー TSV は一切変更しない。全クライアントの設定一致は
   *   利用側責務（設定不一致クライアントは異なる見出しを見る）。2段ヘッダーは v1 対象外。
   * - 不正設定（未知列・空/空白キャプション）は mount 時に `error`（phase=`config`・code=`column-display-invalid`）で
   *   fail-fast する（columnDisplayFormats と同経路）。
   */
  readonly columnCaptions?: Readonly<Record<string, string>>;
  /**
   * 数値/日付の表示書式（ColumnId 文字列→書式・Experimental 0.x・DD-033-2）。両モード共通・mount 時固定
   * （columnTypes/columnFormats と同運用）。**Canvas 描画テキストのみ**を整形する自前ミニ書式。
   * - **契約不変（raw 維持）**: cell-commit/setData round-trip・コピー TSV・columnFormats（DD-027-3）の完全一致・
   *   編集ドラフトは従来の表示文字列（raw）のまま。数値の右寄せ判定・columnFormats の match はすべて raw で行う
   *   （判定は raw・描画は display）。全クライアントの設定一致は利用側責務。
   * - **number** `{ type:'number', grouping?, decimals?, percent?, prefix?, suffix? }`: raw が数値形のときだけ整形し
   *   非数値 raw は素通し。文字列十進・half-up 丸め（decimals 未指定=丸めなし）・grouping=カンマ固定・percent は丸め前に
   *   2桁右シフト・出力順 `prefix + 本体 + ('%') + suffix`。
   * - **date** `{ type:'date', pattern }`: 受理形 `YYYY-MM-DD` と `YYYY-MM-DD[T|空白]HH:mm(:ss)` のみ整形
   *   （フィールド直取り・タイムゾーン非経由）。トークン `YYYY/MM/DD/HH/mm/ss` を置換しトークン以外はリテラル素通し。
   *   非受理形・時刻欠落 raw への時刻トークンは raw 素通し（00 を埋めない）。
   * - **併用制約**: wrapColumns 同一列・link 列との併用は mount 時 fail-fast（構造不整合/クリック乖離）。select 列は許可
   *   （候補・検証・ドロップダウン表示は raw のまま）。Excel 書式文字列互換・Intl ロケール書式は v1 対象外（拡張点メモ）。
   * - 不正設定（未知列・不正 type・decimals 非整数/0〜20外・pattern 空/既知トークン皆無・wrap/link 併用）は mount 時に
   *   `error`（phase=`config`・code=`column-display-invalid`）で fail-fast する。
   */
  readonly columnDisplayFormats?: Readonly<Record<string, GridColumnDisplayFormat>>;
  /**
   * 表示専用モード（Experimental 0.x・DD-033-1）。`true` で「文書を一切変更できない閲覧専用グリッド」になる。
   * 両モード共通・mount 時固定（columnTypes/columnFormats と同運用・実行時切替は対象外）。
   * - **抑止（文書変更系）**: 編集開始（印字キー・F2・ダブルクリック・IME）／paste・cut／Delete・Backspace クリア／
   *   行挿入削除（ショートカット・公開 API `insertRows`/`deleteRows`）／Undo・Redo／選択式列のドロップダウン。
   *   抑止した経路では `onDiagnostic` に info（code=`readonly-blocked`）を出す（既定＝hook 未指定なら無コスト）。
   * - **維持（閲覧系）**: 範囲選択・コピー（TSV は従来と同一）・スクロール・列幅/行高リサイズ・列境界 dblclick の
   *   auto-fit・link-open。`setData`（プログラム的な表示データ差し替え）も許可する。
   * - **共同編集モード**: リモート更新は画面へ反映し、自クライアントからの文書 Operation 送信はゼロ（受信専用）。
   *   presence（閲覧位置）は従来どおり送信する（文書 Operation ではない）。全クライアントの設定一致は利用側責務。
   * - **注意**: readOnly は表示制御であって**権限制御ではない**（サーバー側強制なし＝改ざん防止は利用側責務）。
   * - 値は boolean 単値。`true` の厳密一致でのみ表示専用になり、`undefined` 以外の非 boolean は診断 warn
   *   （code=`readonly-invalid`）を出して編集可能側へ倒す（構成不整合が無いため mount fail-fast はしない）。
   */
  readonly readOnly?: boolean;
  /** 初期イベント購読（mount 直後の connection/error/cell-commit を取りこぼさない）。 */
  readonly onEvent?: GridEventListener;
  /**
   * 診断ログ hook（opt-in・既定無出力）。指定すると boot/接続/競合/破棄などの診断エントリが配信される。
   * 未指定なら診断は生成されない（性能影響なし）。障害切り分け用で GridEvent（consumer 契約）とは別系統。
   */
  readonly onDiagnostic?: GridDiagnosticHook;
}

/** 共同編集モードの mount オプション（Experimental 0.x）。`mode` 省略時は共同編集（後方互換）。 */
export interface GridCollaborationMountOptions extends GridCommonMountOptions {
  /** モード判別子。省略可（既定＝共同編集）。 */
  readonly mode?: 'collaboration';
  /** 同期サーバーの HTTP オリジン（例 'http://127.0.0.1:8787'）。ws URL・/config はここから導出する。 */
  readonly serverUrl: string;
  /** 編集対象ドキュメント ID。未指定なら /config の documentId を使う。 */
  readonly documentId?: string;
  /** 列順。未指定なら serverUrl の /config から取得する（server-hono と対で運用・D1）。 */
  readonly columnOrder?: readonly string[];
  /** Presence 表示名。未指定なら匿名生成する。 */
  readonly displayName?: string;
  /** 再接続で不変のクライアント ID。未指定なら生成する（crypto.randomUUID）。 */
  readonly clientId?: string;
}

/**
 * 単独グリッドモードの mount オプション（Experimental 0.x・DD-024）。共同編集サーバー無しで mount する。
 * `serverUrl`/`displayName`/`clientId` は宣言しない（型で排他・混在指定はリテラルでコンパイルエラー、
 * JS 経路は config error で fail-fast）。認証・保存の責務は全面的に利用側アプリ（roadmap §6）。
 */
export interface GridStandaloneMountOptions extends GridCommonMountOptions {
  /** モード判別子（必須）。 */
  readonly mode: 'standalone';
  /** 列順（必須。/config が無いので利用側が与える）。 */
  readonly columnOrder: readonly string[];
  /** 編集対象ドキュメント ID（任意・表示/識別用）。 */
  readonly documentId?: string;
  /** mount 時の静的初期データ（決定③）。mount 後の再注入は GridInstance.setData。 */
  readonly initialData?: GridStandaloneData;
}

/**
 * mount 時オプション（Experimental 0.x）。`mode` を判別子とする union（DD-024・決定①）。
 * 既存 consumer（`{ serverUrl }`・mode 省略）は共同編集変種として引き続き成立する（後方互換）。
 */
export type GridMountOptions = GridCollaborationMountOptions | GridStandaloneMountOptions;

/** mount が返すハンドル（consumer lifecycle 契約）。 */
export interface GridInstance {
  /** 編集対象ドキュメント ID（/config 解決後に確定。未解決時は options.documentId ?? ''）。 */
  readonly documentId: string;
  /** 現在の接続状態。 */
  connectionState(): GridConnectionState;
  /** イベント購読。返り値の関数で解除（unsubscribe）する。 */
  subscribe(listener: GridEventListener): () => void;
  /** グリッドへフォーカスする（入力受け口の常駐 textarea へ）。 */
  focus(): void;
  /**
   * 単独グリッドモード（DD-024・決定③）で文書を丸ごと再注入する（react-query 等の非同期取得・保存失敗時の
   * 見た目復元に使う）。共同編集モードで呼ぶと no-op（診断 warn を出す）。編集中に呼ぶと編集対象行が
   * 差し替わりうる（利用側は編集完了後の再注入を推奨）。
   */
  setData(data: GridStandaloneData): void;
  /**
   * 行を挿入する（Experimental 0.x・DD-021-1・両モード）。`afterRowId` の直後へ `count` 行（既定 1）を挿入する
   * （`afterRowId=null` で先頭へ）。新 RowId は `crypto.randomUUID` で採番し `row-structure-change`（kind=insert）で
   * 返す。**同期 throw しない**（既存 API 流儀）: `count` が 1〜100,000 の整数でない・未知アンカーは実行前拒否として
   * `rejected` イベント（共同編集モード・`operationId` は空文字）＋診断で通知し、文書は無変更（単独モードは診断のみ）。
   * boot 未完了時は黙って無視する（`setData` と異なり保留適用しない）。接続終端（`connectionState()==='stopped'`）後は
   * no-op（診断のみ）。
   */
  insertRows(options: { readonly afterRowId: string | null; readonly count?: number }): void;
  /**
   * 行を削除する（Experimental 0.x・DD-021-1・両モード）。`rowIds` のうち実在（非 tombstone）の行を tombstone 化し
   * `row-structure-change`（kind=delete）で通知する（重複・非現存は無視）。削除でアクティブ行が消えたら
   * 最近傍生存行（下優先→上）へ activeCell を縮退する。実在対象が皆無なら実行前拒否（`rejected`/診断・文書無変更）。
   */
  deleteRows(rowIds: readonly string[]): void;
  /** グリッドを破棄し DOM/listener/RAF/WS/canvas/textarea を解放する（再mountで leak しない）。 */
  destroy(): void;
}

/** 公開 API バージョン（Experimental 0.x・ADR-0015。破壊的変更は CHANGELOG=DD-017 で記録）。 */
export const GRID_API_VERSION = '0.1.0-experimental' as const;

/**
 * Canvas グリッドを container へマウントする。同期 return（boot＝/config 取得・WS 接続は内部で非同期進行し、
 * 進捗・失敗は GridEvent で通知する）。destroy() は boot 進行中に呼んでも安全。
 */
export function mount(target: GridMountTarget, options: GridMountOptions): GridInstance {
  return createGridController(target, options);
}
