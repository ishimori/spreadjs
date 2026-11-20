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
import type { GridAppearance } from './appearance';
export type { GridAppearance } from './appearance';

// 公開エラー語彙・診断 hook は Facade 自前モジュールが定義する（内部 package 型ではない＝R7 に反さない）。
export { GRID_ERROR_CODES, GRID_CONFLICT_CODES } from './error-codes';
export type { GridErrorCode, GridConflictCode } from './error-codes';
export type { GridDiagnostic, GridDiagnosticLevel, GridDiagnosticHook } from './diagnostics';

import type { GridConflictCode, GridErrorCode } from './error-codes';
import type { GridDiagnosticHook } from './diagnostics';

// 列タイプ体系（DD-027-1・Experimental 0.x）。公開型は grid 自身（column-types.ts）で定義する（内部 package 型
// ではない＝R7 に反さない）。registry 本体は Internal で、consumer 向けの登録 API は公開しない（決定⑤）。
export type { GridColumnType, GridSelectColumnType, GridLinkColumnType, GridDateColumnType, GridNumberColumnType } from './column-types';
import type { GridColumnType } from './column-types';

// セル書式モデル（DD-027-3・Experimental 0.x）。利用側供給の「値→書式マッピング」による view-local 描画。
// 公開型は grid 自身（format-rules.ts）で定義する（内部 package 型ではない＝R7 に反さない）。
export type { GridColumnFormatRule, GridCellFormatStyle } from './format-rules';
import type { GridColumnFormatRule } from './format-rules';
export type { GridBorder, GridRowBorders, GridColumnBorders } from './border-rules';
import type { GridBorder, GridRowBorders, GridColumnBorders } from './border-rules';
// セルの結合と2段の見出し（DD-064・Experimental 0.x）。公開型は grid 自身（merged-cell-spec.ts・column-groups.ts）で定義する（R7）。
export type { GridMergedCell } from './merged-cell-spec';
import type { GridMergedCell } from './merged-cell-spec';
export type { GridColumnGroup } from './column-groups';
import type { GridColumnGroup } from './column-groups';
// 見出しの印（DD-070-6・Experimental 0.x）。公開型は grid 自身（header-marks.ts）で定義する（R7）。
export type { GridColumnHeaderMark, GridColumnGroupMark } from './header-marks';
import type { GridColumnGroupMark, GridColumnHeaderMark } from './header-marks';

// 列見出しキャプション＋数値/日付の表示書式（DD-033-2・Experimental 0.x）。Canvas 描画テキストのみを整形する
// view-local 書式（raw 契約不変）。公開型は grid 自身（display-format.ts）で定義する（R7 に反さない）。
export type {
  GridColumnDisplayFormat,
  GridNumberDisplayFormat,
  GridNegativeNumberFormat,
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
  | { readonly type: 'link-open'; readonly rowId: string; readonly columnId: string; readonly value: string }
  /**
   * サーバー確定（受理済み）のセル変更の通知（Experimental 0.x・DD-049 H4・**共同編集モード専用**）。SetCells が committed に
   * 入るたび 1 op＝1 イベント（revision 昇順）。他クライアント（`origin:'remote'`）・サーバー起点操作（`'server'`）に加え、
   * 自分の確定もサーバーの確定後に `'local'` で届く（利用側の「変更履歴」を 1 経路で作れる）。楽観適用のまま rollback/reject
   * された op、snapshot bootstrap（初回接続・1,000 revision 超の差分がある再接続）で確立した状態、行の挿入・削除は通知しない。
   * 1 サーバーメッセージの処理（適用・描画の dirty 立て）が終わってから配るため、listener から命令 API を呼んでよい。
   * 単独グリッドモードでは発火しない（確定は従来どおり cell-commit）。
   */
  | { readonly type: 'remote-change'; readonly change: GridRemoteChange }
  /**
   * 参加者一覧の変化通知（Experimental 0.x・DD-049 H5・**共同編集モード専用**）。先頭に自分（`self:true`）、続いて他者を
   * サーバーから届いた順に並べた一覧が、直前に配った一覧と変わったとき（初回 join・他者の参加/アクティブセル移動/切断/
   * TTL 失効・自分のアクティブセル移動＝editor の処理後のマイクロタスクでまとめて）だけ発火する。現在値は
   * `GridInstance.presences()`。自分が切断中は最後に知っていた
   * 一覧を保持する（オンライン判定は connection イベントと併用する）。
   * **「参加」＝join 完了時点**（DD-053 H10）: セルを選ばずに開いただけの利用者も一覧に載る
   * （`activeCell: null`。名前タグ等の描画は既存どおり `activeCell` が付くまで出ない）。再接続でも同様に、
   * 選択前後を問わず一覧から消えない。
   */
  | { readonly type: 'presence'; readonly users: readonly GridPresenceUser[] }
  /**
   * 列見出しのクリック通知（Experimental 0.x・DD-052-5 RC5・両モード共通）。列記号ヘッダー（A/B/C…・
   * `columnCaptions` があればその見出し）を押下すると発火する。**並べ替えは行わない**（利用側が `columnId` を
   * 受けて任意の並べ替え・表示切替を実装する＝責務境界）。行番号ヘッダー・左上コーナーのクリックでは発火しない。
   * 既存のセルクリック（選択・編集開始）の挙動は変えない。
   * DD-070-6: `rect` は見出しのセルの viewport 矩形（2 段の見出しでまとめた列は下の段。候補欄を見出しの下に出す位置に使う）、
   * `target` は絞り込みのボタン（`columnHeaderMarks` の `filter`）の上なら `'filter'`、それ以外は `'caption'`。
   * 2 段の見出しの上の段のクリックは `column-group-click`。
   */
  | {
      readonly type: 'header-click';
      readonly columnId: string;
      readonly rect: GridCellRect;
      readonly target: 'caption' | 'filter';
    }
  /**
   * 2 段の見出しの上の段（列のまとまり）のクリックの通知（Experimental 0.x・DD-070-6・両モード共通）。`groupId` はまとまりの
   * `id`（省略時は `caption`）、`columnIds` はまとめた列、`rect` は上の段のまとまりの矩形。折りたたみの切り替えは consumer が
   * 行う（印は `setColumnGroupMarks`、見せる列は DD-070-7）。
   */
  | {
      readonly type: 'column-group-click';
      readonly groupId: string;
      readonly caption: string;
      readonly columnIds: readonly string[];
      readonly rect: GridCellRect;
    }
  /**
   * セルのホバー通知（Experimental 0.x・DD-052-5 RC6・両モード共通）。ポインタの位置するセルが変わった
   * ときだけ発火する（同一セル内の移動では再発火しない＝間引き済み）。グリッド外・見出し領域・ドラッグ中
   * （範囲選択・列幅リサイズ）はホバー対象外で、その状態に入ると `rowId`/`columnId`/`rect` が全て `null` の
   * イベントが 1 回発火する。`rect` はセルの viewport 矩形（px・スクロール反映済み）で、利用側がツールチップ等を
   * 自前で描画するための位置情報（**SDK 自体はホバー表示を描画しない**）。
   * DD-060: セルに状態表示（`GridStandaloneRow.cellStatus`）があれば `status` に載る（無ければキー自体を付けない）。
   * ホバー中のセルの状態が `setRows`／`setData`／`setCellStatus`（DD-062）で変わったときは、同じセルのままでも出し直す。
   */
  | {
      readonly type: 'cell-hover';
      readonly rowId: string | null;
      readonly columnId: string | null;
      readonly rect: GridCellRect | null;
      readonly status?: GridCellStatus;
    }
  /**
   * 確定前の検証（mount オプション `validateCell`）で拒否された通知（Experimental 0.x・DD-063・両モード共通）。
   * 拒否された入力は捨てられ（文書・サーバー・Undo は変わらない）、編集は閉じる。`source` は確定の経路
   * （`edit`=IME/textarea・`select`=選択式の候補・`date`=日付のカレンダー・`paste`=貼り付け・`fill`=Ctrl+D／Ctrl+R〔DD-070-3〕）。貼り付けと
   * fill は 1 件でも不正なら全体を拒否し、不正なセルを全部 `cells` に載せる。確定処理が終わった後（microtask）に出るので、
   * 購読者から `setActiveCell` 等を呼んでも後続の移動に上書きされない。
   */
  | {
      readonly type: 'cell-invalid';
      readonly source: 'edit' | 'select' | 'date' | 'paste' | 'fill';
      readonly cells: readonly GridInvalidCell[];
    }
  /**
   * 読むだけのセルへの編集を止めた通知（Experimental 0.x・DD-069・両モード共通）。選択中のセルで印字キー（日本語入力オンの
   * 打鍵を含む）・Delete／Backspace・F2 を、ダブルクリックしたセルで編集の開始を止めたときと、表全体が読み取り専用
   * （`readOnly`）で貼り付け・切り取り・範囲の消去・Ctrl+D／Ctrl+R（`fill`・DD-070-3）を止めたときに、1 回の操作で 1 回出す。
   * 文書は変わらない。
   * consumer が止めた理由と直す先を利用者に示すために使う。印字キー（`input: 'key'`）は打鍵の処理が済んだ後（次のキー・クリックの
   * 処理より前）に、それ以外は止めたその場で出すので、受け取ってすぐ `setActiveCell` などを呼んでよい（届く順は操作の順）。
   * 変換中・編集中（Navigation でない位相）と、選択式の候補欄・日付のカレンダーを開くのを止めたときは出さない。
   */
  | {
      readonly type: 'edit-blocked';
      readonly rowId: string;
      readonly columnId: string;
      readonly input: GridEditBlockedInput;
      readonly reason: GridEditBlockedReason;
    }
  /**
   * 範囲の操作で読むだけのセルを飛ばした通知（Experimental 0.x・DD-069・両モード共通）。貼り付け・切り取りのクリア・範囲の
   * 消去・Ctrl+D／Ctrl+R（`fill`・DD-070-3）が、読み取り専用の列・行・セルや結合範囲にかかって変えずに残したセルを `cells` に載せる（範囲が 1 セルでも同じ。
   * 変える値の無い空のセルは載せない）。ほかのセルへの適用は従来どおり行う（全部を飛ばしたら文書は変わらない）。
   */
  | {
      readonly type: 'cells-skipped';
      readonly operation: 'paste' | 'cut' | 'clear' | 'fill';
      readonly cells: readonly GridCellRef[];
    }
  /**
   * 選択が変わった通知（Experimental 0.x・DD-070-2・両モード共通）。`activeCell` は選択中のセル、`range` は枠を描いている範囲
   * （1 セルだけのときも 1 × 1。結合の左上ならその結合全体。ドラッグ中はドラッグの範囲）。前に知らせた内容と変わったときだけ、
   * 描画のループで 1 フレームに 1 回まで出す（初回のデータの描画の後に最初の選択を 1 回）。行の並びが変わって番号だけが
   * 変わったときは出さない（ID で比べる）。描画のループの中で出すので、受け取ってすぐ命令 API を呼んでよい。今の値は `GridInstance.selection()`。
   */
  | {
      readonly type: 'selection-change';
      readonly activeCell: GridCellRef | null;
      readonly range: GridCellRange | null;
    }
  /**
   * 本体のセルのダブルクリックの通知（Experimental 0.x・DD-070-2・両モード共通）。SDK の既定の動き（編集の開始・選択式の候補欄・
   * 日付のカレンダー・読むだけのセルの `edit-blocked`）の後に出す（既定の動きは止めない）。結合範囲は左上のセル。
   * 見出し・列の境界（幅の自動調整）・行番号では出さない。
   */
  | { readonly type: 'cell-dblclick'; readonly rowId: string; readonly columnId: string };

/** セルの範囲（DD-070-2）。表示の並びで左上（start）と右下（end）のセル。 */
export interface GridCellRange {
  readonly startRowId: string;
  readonly startColumnId: string;
  readonly endRowId: string;
  readonly endColumnId: string;
}

/** `GridInstance.getRows` の 1 行（DD-070-5）。単独モードの行データと同じ形（`cells` は ColumnId → 表示文字列・空のセルは無し）。 */
export interface GridRowData {
  readonly rowId: string;
  readonly cells: Readonly<Record<string, string>>;
}

/** `GridInstance.getRows` の絞り込み（DD-070-5）。未知の列・未知や削除済みの行は無視する。 */
export interface GridReadRowsOptions {
  /** 読む列（既定は全部の列）。並べ替え・絞り込みにはキーの列だけを読むと軽い。 */
  readonly columnIds?: readonly string[];
  /** 読む行（既定は全部の行）。返す並びは文書の並び。 */
  readonly rowIds?: readonly string[];
}

/** 今の選択（DD-070-2）。`selection-change` イベントと同じ形。行が無い・boot 前・destroy 後は両方 null。 */
export interface GridSelection {
  readonly activeCell: GridCellRef | null;
  readonly range: GridCellRange | null;
}

/**
 * セルの状態表示（Experimental 0.x・DD-060）。consumer が確定後に検証した結果をセルに付ける。
 * `error`=赤枠＋薄赤の背景・`warning`=橙枠＋薄黄の背景で、値の有無によらず描く（色は固定）。
 * `message` は描画せず、ホバー時の `cell-hover` の `status` に載る（ツールチップは利用側が出す）。
 */
export interface GridCellStatus {
  readonly level: 'error' | 'warning';
  readonly message?: string;
}

/** `validateCell` に渡す、確定しようとしているセル（DD-063）。`value` は cell-commit の `value` と同じ表示文字列。 */
export interface GridCellValidationInput {
  readonly rowId: string;
  readonly columnId: string;
  readonly value: string;
}

/** `cell-invalid` イベントで拒否されたセル（DD-063）。`message` は `validateCell` が返した文字列。 */
export interface GridInvalidCell extends GridCellValidationInput {
  readonly message: string;
}

/** `setCellStatus` に渡す 1 行（DD-062）。`cellStatus` は ColumnId 文字列→状態（`{}` でその行の状態を消す）。 */
export interface GridCellStatusRow {
  readonly rowId: string;
  readonly cellStatus: Readonly<Record<string, GridCellStatus>>;
}

/** セルの位置（DD-069）。RowId と ColumnId の文字列。 */
export interface GridCellRef {
  readonly rowId: string;
  readonly columnId: string;
}

/** `edit-blocked` で止めた操作（DD-069）。`key` は印字キー（日本語入力オンの打鍵を含む）、`delete` は Delete／Backspace、`fill` は Ctrl+D／Ctrl+R（DD-070-3）。 */
export type GridEditBlockedInput = 'key' | 'delete' | 'f2' | 'dblclick' | 'paste' | 'cut' | 'clear' | 'fill';

/**
 * `edit-blocked` の理由（DD-069）。`readonly-column`=mount の `readOnlyColumns`・`readonly-row`=`readOnlyRows`・
 * `readonly-cell`=行データの `readOnlyColumns`・`merged`=結合範囲・`grid-readonly`=表全体の `readOnly`。
 */
export type GridEditBlockedReason = 'readonly-column' | 'readonly-row' | 'readonly-cell' | 'merged' | 'grid-readonly';

/** `setCellBackgrounds` に渡す 1 行（DD-069）。`cellBackgrounds` は ColumnId 文字列→CSS color（`{}` でその行の背景を消す）。 */
export interface GridCellBackgroundRow {
  readonly rowId: string;
  readonly cellBackgrounds: Readonly<Record<string, string>>;
}

/** セルの状態表示の 1 水準の色（DD-061・省略した項目は既定色）。 */
export interface GridCellStatusColor {
  /** 罫線の内側の 2px の枠の色。 */
  readonly frame?: string;
  /** セル全体の背景の色。 */
  readonly background?: string;
}

/** セルの状態表示の色（mount オプション `cellStatusColors`・DD-061）。 */
export interface GridCellStatusColors {
  readonly error?: GridCellStatusColor;
  readonly warning?: GridCellStatusColor;
}

/** セルの viewport 矩形（px・DD-052-5）。内部の CellRect（render package）は露出しない（R7）。 */
export interface GridCellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

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

/** セル番地（RowId/ColumnId 文字列・DD-049）。内部の CellAddressById は露出しない（R7）。 */
export interface GridCellAddress {
  readonly rowId: string;
  readonly columnId: string;
}

/**
 * remote-change の起点（DD-049 H4）。`'local'`＝この grid が送った op（サーバー確定後の echo）／`'remote'`＝他クライアント
 * （同じ利用者の別タブを含む）／`'server'`＝サーバー起点操作（server-hono の `ServerInstance.submit`）。
 */
export type GridRemoteChangeOrigin = 'local' | 'remote' | 'server';

/** サーバー確定（受理済み）のセル変更 1 op 分（DD-049 H4）。 */
export interface GridRemoteChange {
  readonly origin: GridRemoteChangeOrigin;
  /** サーバー付与の revision（文書内で一意・昇順に届く）。 */
  readonly revision: number;
  /** 受理 envelope の actorId（サーバーの authenticate 指定時はサーバーが確定した利用者 ID）。 */
  readonly actorId: string;
  /** セル変更（cell-commit と同じ形＝表示文字列の前後値・op の changes 順）。 */
  readonly changes: readonly GridCellCommitChange[];
}

/** 参加者 1 件（DD-049 H5）。1 接続 1 件（同じ利用者の複数タブは別エントリ）。 */
export interface GridPresenceUser {
  /**
   * 利用者 ID。他者は presence の userId（サーバーの authenticate 指定時はサーバーが確定した actorId）。自分は grid の
   * clientId（authenticate でサーバーが上書きする構成では他者から見た値と一致しない＝自分の判定は `self` を使う）。
   */
  readonly userId: string;
  /** 表示名（他者はサーバーの authenticate 指定時はサーバー確定値・自分は mount の displayName）。 */
  readonly displayName: string;
  /** アクティブセル（編集中は編集セル）。presence 未送信なら null。 */
  readonly activeCell: GridCellAddress | null;
  /** この grid インスタンス自身なら true（一覧の先頭に 1 件）。 */
  readonly self: boolean;
}

export type GridEventListener = (event: GridEvent) => void;

/** `GridInstance.flush` のオプション（DD-056 H12）。 */
export interface GridFlushOptions {
  /** 待つ上限（ミリ秒・既定 10,000）。正の有限数以外は既定値。 */
  readonly timeoutMs?: number;
}

/** `GridInstance.flush` の結果（DD-056 H12）。Promise は reject せず、この結果で返す。 */
export type GridFlushResult =
  /** 呼んだ時点の編集中のセルは確定済みで、自分の操作はすべてサーバーで受理または拒否された（拒否は `rejected` イベントで通知済み）。 */
  | { readonly status: 'flushed' }
  /** 上限まで待っても送り切れなかった。`editing: true` は IME 変換中などで、呼んだ時点の編集中のセルを確定できていない。 */
  | { readonly status: 'timeout'; readonly pendingCount: number; readonly editing: boolean }
  /** 送り切れないまま接続が終端した（切断の上限超過・divergence）か、待つ間に destroy された。未送信の操作は送られない。 */
  | { readonly status: 'stopped'; readonly pendingCount: number };

/** 単独グリッドモードの 1 行（DD-024）。cells は ColumnId 文字列→値文字列（未指定列は空セル）。 */
export interface GridStandaloneRow {
  readonly rowId: string;
  readonly cells?: Readonly<Record<string, string>>;
  /**
   * RC3（DD-052-3）: この行だけを読み取り専用にする列（ColumnId 文字列の配列・Experimental 0.x）。
   * mount 時の `readOnlyColumns`（全行に効く列単位の読み取り専用）とは別軸で、**この行のセルにだけ**追加で
   * 効く（両方に該当すれば当然 readOnly）。`setData` で行ごと差し替えるたびに再評価される（remount 不要）。
   * 抑止・スキップ・保証層の契約は `readOnlyColumns`/`readOnlyRows` と同型。**standalone モード専用**
   * （共同編集モードでは無視される。行の編集権限は将来スコープ）。未知列は静かにスキップする。
   */
  readonly readOnlyColumns?: readonly string[];
  /**
   * DD-060: この行のセルの状態表示（ColumnId 文字列→状態・Experimental 0.x）。consumer が確定後に検証して付け外しする。
   * 文書のデータではない（cell-commit・コピー・Undo/Redo の対象外。利用者がセルを編集しても消えない）。
   * `setRows` では渡した行の状態を丸ごと置き換え、省略した行は前の状態を保つ（`{}` で消す＝`readOnlyColumns` と同じ）。
   * `setData`／`initialData` では文書と一緒に作り直す。行データでの指定は **standalone モード専用**（両モードで使える
   * `GridInstance.setCellStatus`〔DD-062〕と同じ置き場）。未知列は静かにスキップし、
   * `level` が `error`/`warning` 以外のセルは無視して診断 `warn`（code=`cell-status-invalid`）を出す。
   */
  readonly cellStatus?: Readonly<Record<string, GridCellStatus>>;
  /**
   * DD-069: この行のセルごとの背景色（ColumnId 文字列→CSS color・Experimental 0.x）。行・列の背景（`rowBackgrounds`・
   * `columnBackgrounds`）より勝ち、状態表示（`cellStatus`）と値ベース書式の背景には負ける。文書のデータではない（view-local）。
   * `setRows`・`setData`・`initialData` での扱いは `cellStatus` と同じ（渡した行は丸ごと置き換え・省略した行は保つ・`{}` で
   * 消す・未知列は静かにスキップ）。空・空白だけの色のセルは無視して診断 `warn`（code=`cell-background-invalid`）を出す。
   * 行データでの指定は **standalone モード専用**（両モードで使える `GridInstance.setCellBackgrounds` と同じ置き場）。
   */
  readonly cellBackgrounds?: Readonly<Record<string, string>>;
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
  /** 初回mountに適用する表示専用のfont/罫線設定。行高はrowHeightsで指定する。 */
  readonly appearance?: GridAppearance;
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
   *   候補のみの列で印字文字を打つと、候補欄を開いて前方一致する最初の候補を選ぶ（大小文字は無視）。開いている間は
   *   文字を追加し Backspace で1文字戻す。不一致・全消去は選択なしで、Enter でも値を変えない。IME の確定文字による
   *   検索は対象外。日本語候補は矢印またはクリックで選ぶ。自由入力併存列の動きは変わらない（DD-057）。
   *   paste / setData / リモート由来の非候補値は検証されず保持・表示される（拒否しない＝データ非破壊・収束優先）。
   * - **リンク**: 値は string 1本。クリックで `link-open` イベントが発火する（**SDK は navigate しない**が既定）。
   *   `defaultOpen:true` のときだけ絶対 http/https URL を `window.open(_,'_blank','noopener,noreferrer')` で開く
   *   （javascript:/data:/相対/非URL は open せず診断 warn・link-open は常に発火）。リンク列は wrapColumns と併用不可。
   * - **日付**（DD-035 R2）: `{ type: 'date', openOn? }`。カレンダーのポップオーバーから LocalDate（`YYYY-MM-DD`・ADR-0012）を
   *   選んで確定する（Undo・cell-commit・OCC は既存の確定経路）。**手入力と併存**（印字文字キーは従来どおり textarea 手入力を開始し
   *   `2026/7/31` → `2026-07-31` に正準化）。`openOn:'dblclick'`（既定）=ダブルクリック/F2/Enter/Alt+↓/📅 アイコン、
   *   `'icon'`=📅 アイコン/Alt+↓ のみ。表示書式は `columnDisplayFormats` の date pattern を併用する。型は編集 UI の選択であって
   *   入力規則ではない（非日付文字列の手入力は拒否しない）。readOnly／`readOnlyColumns` の列では開かない。
   * - **数値**（DD-070-4）: `{ type: 'number', invalidMessage? }`。確定しようとしている値が空でなく、SDK の型変換（全角数字・
   *   全角マイナス・3 桁区切りは数値）で数値にならなければ拒否する（`validateCell` と同じ経路＝入力を捨てて `cell-invalid`。
   *   貼り付け・Ctrl+D／Ctrl+R は 1 件でも不正なら全体を拒否）。`invalidMessage` は拒否の `message`（既定「数値を入力してください」）。
   *   数値として通ったセルは、そのあと `validateCell` にも渡す。setData・リモート由来の値は検証しない。`stringColumns` と同じ列は不可。
   * - 不正設定（未知列・候補0件・重複・未対応 type・リンク×wrap 併用・date の `openOn` 不正値・数値×stringColumns 併用・
   *   空の invalidMessage）は mount 時に `error`
   *   （phase=config・code=`column-types-invalid`）で fail-fast する。共同編集モードでの全クライアント設定一致は利用側責務（値は string のまま）。
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
   * - **number** `{ type:'number', grouping?, decimals?, percent?, prefix?, suffix?, negative? }`: raw が数値形のときだけ
   *   整形し非数値 raw は素通し。文字列十進・half-up 丸め（decimals 未指定=丸めなし）・grouping=カンマ固定・percent は丸め前に
   *   2桁右シフト・出力順 `prefix + 本体 + ('%') + suffix`。
   * - **負の数**（DD-059）`negative: { style?, color? }`: `style` は `'minus'`（既定 `-1,234`）・`'triangle'`（`▲1,234`・
   *   `-` と同じ位置）・`'parentheses'`（`(1,234)`・prefix〜suffix の全体を囲む）。`'parentheses'` の列は正の数と 0 の右に
   *   `)` 1文字分の余白を取り正負の桁をそろえる（Excel の `_)`）。`color` は負の数の文字色で、columnFormats の textColor が
   *   一致したセルはそちらが勝つ。0 に丸まる負数は負として扱わない。
   * - **date** `{ type:'date', pattern }`: 受理形 `YYYY-MM-DD` と `YYYY-MM-DD[T|空白]HH:mm(:ss)` のみ整形
   *   （フィールド直取り・タイムゾーン非経由）。トークン `YYYY/MM/DD/HH/mm/ss` を置換しトークン以外はリテラル素通し。
   *   非受理形・時刻欠落 raw への時刻トークンは raw 素通し（00 を埋めない）。
   * - **併用制約**: wrapColumns 同一列・link 列との併用は mount 時 fail-fast（構造不整合/クリック乖離）。select 列は許可
   *   （候補・検証・ドロップダウン表示は raw のまま）。Excel 書式文字列互換・Intl ロケール書式は v1 対象外（拡張点メモ）。
   * - 不正設定（未知列・不正 type・decimals 非整数/0〜20外・pattern 空/既知トークン皆無・negative の不正 style/空 color・
   *   wrap/link 併用）は mount 時に `error`（phase=`config`・code=`column-display-invalid`）で fail-fast する。
   */
  readonly columnDisplayFormats?: Readonly<Record<string, GridColumnDisplayFormat>>;
  /**
   * 表示専用モード（Experimental 0.x・DD-033-1）。`true` で「文書を一切変更できない閲覧専用グリッド」になる。
   * 両モード共通。mount 時の値は初期値で、**実行中は `GridInstance.setReadOnly` で開き直さずに切り替えられる**（DD-056 H12）。
   * - **抑止（文書変更系）**: 編集開始（印字キー・F2・ダブルクリック・IME）／paste・cut／Delete・Backspace クリア／
   *   行挿入削除（ショートカット・公開 API `insertRows`/`deleteRows`）／Undo・Redo／選択式列のドロップダウン。
   *   抑止した経路では `onDiagnostic` に info（code=`readonly-blocked`）を出す（既定＝hook 未指定なら無コスト）。
   * - **維持（閲覧系）**: 範囲選択・コピー（TSV は従来と同一）・スクロール・列幅/行高リサイズ・列境界 dblclick の
   *   auto-fit・link-open。`setData`（プログラム的な表示データ差し替え）も許可する。
   * - **共同編集モード**: リモート更新は画面へ反映し、表示専用の間に自クライアントが新しく作る文書 Operation はゼロ（受信専用）。
   *   `setReadOnly(true)` で切り替えた場合、切り替えの前に作った未送信の操作と、切り替え時に確定した編集中のセルは送られる（DD-056）。
   *   presence（閲覧位置）は従来どおり送信する（文書 Operation ではない）。全クライアントの設定一致は利用側責務。
   * - **注意**: readOnly は表示制御であって**権限制御ではない**（改ざん防止は利用側責務。サーバーで書込を拒否するには
   *   server-hono の `authorizeOperation`〔DD-056 H11〕を使う）。
   * - 値は boolean 単値。`true` の厳密一致でのみ表示専用になり、`undefined` 以外の非 boolean は診断 warn
   *   （code=`readonly-invalid`）を出して編集可能側へ倒す（構成不整合が無いため mount fail-fast はしない）。
   */
  readonly readOnly?: boolean;
  /**
   * 読み取り専用列（ColumnId 文字列の配列・Experimental 0.x・DD-035 R4）。両モード共通・mount 時固定（wrapColumns と同運用）。
   * 列タイプ（select/link/date）と**直交**する属性で、指定列のセルに対して:
   * - **抑止（入口）**: 編集開始（印字キー・F2・ダブルクリック・IME）／Delete・Backspace クリア／選択式ドロップダウン／日付
   *   カレンダー を開かない。アクティブセルが指定列にある間、常駐 textarea は `readOnly` 属性になる（実 IME を物理遮断）。
   * - **範囲操作**: 範囲貼り付け・範囲クリア（Delete）・cut のクリアは指定列のセルだけ**スキップ**して他列へ適用する
   *   （TSV の列位置はずらさない・全セルがスキップなら no-op・診断 info `readonly-column-skipped`）。
   * - **保証層（chokepoint）**: 指定列への変更を含む SetCells は submit 直前で op 全体を破棄する（診断 warn
   *   `readonly-column-blocked`）＝入口をすり抜ける経路でも指定列への文書 Operation 送信ゼロ。
   * - **維持**: 範囲選択・コピー・スクロール・リサイズ・link-open・行挿入削除・setData・リモート受信反映・サーバー起点操作。
   * - **注意**: 権限制御ではない（サーバー側強制なし＝readOnly と同じ）。共同編集の列権限は将来スコープ。
   * - 不正設定（未知列・重複）は mount 時に `error`（phase=config・code=`column-types-invalid`）で fail-fast する。
   */
  readonly readOnlyColumns?: readonly string[];
  /**
   * 文字列として保つ列（ColumnId 文字列の配列・Experimental 0.x・DD-052-2）。両モード共通・mount 時固定
   * （wrapColumns と同運用）。列タイプ（select/link/date）・`wrapColumns` と直交し併用可。指定列は次の経路で
   * 標準の型変換（date → number → string の順で判定・`parseCellInput`）を行わず、**空文字以外は常に string** で
   * 保持する（先頭ゼロ付き電話番号 `09012345678` 等が数値化されて元の文字列表現を失うのを防ぐ）:
   * - 編集確定（IME/textarea の commit）・貼り付け（paste）・`setData`（GridStandaloneRow.cells の再注入）
   * - 空文字は変換対象外で従来どおり blank になる（stringColumns でも変わらない）
   * - `cell-commit` イベント・コピー TSV の値も変換前（string）のまま
   * 未指定列は従来どおり標準の型変換を行う（既定挙動は無変更）。
   */
  readonly stringColumns?: readonly string[];
  /**
   * 読み取り専用行（RowId 文字列の配列・Experimental 0.x・DD-036 C3）。両モード共通・mount 時固定。
   * `readOnlyColumns`（DD-035 R4）の**行版**で、抑止・スキップ・保証層は同型（両方指定なら和＝どちらかに該当する
   * セルが読み取り専用）:
   * - **抑止（入口）**: 指定行のセルがアクティブな間、編集開始（印字キー・F2・ダブルクリック・IME）／Delete・Backspace
   *   クリア／選択式ドロップダウン／日付カレンダー を開かない。常駐 textarea は `readOnly` 属性になる（実 IME を物理遮断）。
   * - **範囲操作**: 範囲貼り付け・範囲クリア（Delete）・cut のクリアは指定行のセルだけ**スキップ**して他行へ適用する
   *   （TSV の行位置はずらさない・全セルがスキップなら no-op・診断 info `readonly-row-skipped`）。
   * - **保証層（chokepoint）**: 指定行への変更を含む SetCells は submit 直前で op 全体を破棄する（診断 warn
   *   `readonly-row-blocked`）＝入口をすり抜ける経路でも指定行への文書 Operation 送信ゼロ。
   * - **維持**: 範囲選択・コピー・スクロール・リサイズ・link-open・行挿入削除・setData・リモート受信反映。
   * - **未知 RowId は診断 warn のみ**（code=`readonly-row-unknown`・初回描画後に 1 回だけ判定）。列と違い行は初期データ
   *   到着前に検証できないため fail-fast しない（`readOnlyColumns` の `column-types-invalid` とは扱いを分ける）。
   *   重複指定は無害（集合として扱う）。
   * - **注意**: 権限制御ではない（サーバー側強制なし＝`readOnly` / `readOnlyColumns` と同じ）。
   */
  readonly readOnlyRows?: readonly string[];
  /**
   * 行操作ショートカット（Ctrl+Shift+'+'=挿入／Ctrl+'-'=削除・Excel 準拠）の有効・無効（Experimental 0.x・
   * DD-052-3 RC14）。既定 `true`（従来どおり有効）。`false` にすると単独モードのショートカットで行を追加・削除
   * できなくなる（他の編集は従来どおり可能）。**公開 API `insertRows`/`deleteRows` の呼び出しは対象外**
   * （consumer の明示的な行操作までは止めない＝ボタン等からの意図的な追加・削除は妨げない）。両モード共通。
   */
  readonly rowOperations?: boolean;
  /**
   * 固定行数（先頭 n 行・Experimental 0.x・DD-036 C1）。既定 1（＝DD-036 以前の固定値と完全一致）。`0` で固定なし。
   * 両モード共通・mount 時固定・**view-local**（文書状態にしない＝設定が異なるクライアントは異なる見え方をする）。
   * 0 以上の整数以外は診断 warn（code=`frozen-count-invalid`）を出して既定 1 へ倒す（mount は成功する）。
   * 実際の行数を超える指定は行数でクランプされる（全行が固定＝スクロール領域が空になるだけ）。
   */
  readonly frozenRowCount?: number;
  /**
   * 固定列数（先頭 n 列・Experimental 0.x・DD-036 C1）。既定 1。`frozenRowCount` と同じ検証・クランプ・view-local 契約。
   * 横スクロールしても先頭 n 列が画面左に残る（マトリクス型シートのラベル列）。
   */
  readonly frozenColumnCount?: number;
  /**
   * 列単位の静的背景色（ColumnId 文字列→CSS color・Experimental 0.x・DD-036 C2）。両モード共通・mount 時固定
   * （columnFormats と同運用）。**値によらない列全体の背景色**（非稼働日の網掛け等）。
   * - **空セルも塗る**（`columnFormats` は非空セルのみ＝別経路）。罫線・選択・Presence は従来どおり上に乗る。
   *   固定 pane の列も指定色で塗られる（固定背景色より優先）。
   * - **優先順位**: 同一セルに `columnFormats` の値ベース背景が解決されたら**値ベースが勝つ**。値ベース書式が無いセル
   *   （空セル・非一致値）は静的列色のまま。
   * - **view-local**（描画のみ）: 文書状態・cell-commit・コピー TSV は一切変更しない。全クライアントの設定一致は
   *   利用側責務（`cell-format-sharing-design.md`）。
   * - 不正設定（未知列・空/空白のみの色）は mount 時に `error`（phase=`config`・code=`column-types-invalid`）で
   *   fail-fast する（columnFormats と同経路）。色文字列の妥当性は検査しない（Canvas は不正値を無視＝安全）。
   */
  readonly columnBackgrounds?: Readonly<Record<string, string>>;
  /**
   * 行単位の静的背景色（RowId 文字列→CSS color・Experimental 0.x・DD-045）。両モード共通・mount 時固定・view-local。
   * - 空セルを含む行全体を塗り、固定 pane と横スクロール先でも帯を連続させる。
   * - 行/列背景の交差は行背景が勝ち、`columnFormats` の値ベース背景はさらに上から勝つ。
   * - RowId は描画時に現在位置へ解決するため、行挿入・削除後も同じ行実体へ追従する。
   * - 未知 RowId は初回描画後に診断 warn `row-background-unknown` のみ。空/空白色は mount 時 fail-fast。
   * 文書状態・protocol・snapshot・hash・cell-commit・コピー TSV は変更しない。
   */
  readonly rowBackgrounds?: Readonly<Record<string, string>>;
  /**
   * セルの状態表示（`GridCellStatus`・DD-060）の色（Experimental 0.x・DD-061）。両モード共通・mount 時固定。
   * 省略した水準・項目は既定色（error=枠 `#d93025`・背景 `#fce8e6`、warning=枠 `#e37400`・背景 `#fef7e0`）。
   * `error`/`warning` 以外のキー・`frame`/`background` 以外のキー・空や空白だけの色は mount 時 fail-fast
   * （code=`column-types-invalid`）。CSS の色としての妥当性は検査しない（不正な色は既定色で描く）。
   */
  readonly cellStatusColors?: GridCellStatusColors;
  /**
   * 確定前の検証（Experimental 0.x・DD-063）。両モード共通・同期。確定しようとしている値ごとに呼ばれ、文字列を返すと
   * 拒否（その文字列がメッセージ）、`null` なら通す。拒否された入力は捨てられ、`cell-invalid` イベントで通知される。
   * - 検証する経路: IME/textarea の確定・選択式の候補の確定・日付のカレンダーの確定・貼り付け（1 件でも不正なら全体を拒否）
   * - 検証しない経路: 空にする確定（Delete・範囲クリア・cut・空のまま確定）・Undo/Redo・`setRows`/`setData`・リモートの変更
   * - 例外を投げたら通す（診断 `error`・code=`validate-cell-threw`）。読み取り専用・選択式の候補検証が先に効く
   */
  readonly validateCell?: (cell: GridCellValidationInput) => string | null;
  /** 行ID→上下の罫線（CSS px、0超〜8以下）。未知行はwarn後に遅延解決。mount時固定・表示専用。 */
  readonly rowBorders?: Readonly<Record<string, GridRowBorders>>;
  /** 列ID→左右の罫線。本文と列見出しへ同じ線を描く（2段見出しのグループ内は下段だけ）。隣接指定は太い線、同幅は右列leftが勝つ。文字overflowは指定境界で止まる。 */
  readonly columnBorders?: Readonly<Record<string, GridColumnBorders>>;
  /** 全データ行の下端（最終行を含む）へ共通罫線。個別top/bottom優先・行増減に追従。mount時固定。 */
  readonly defaultRowBorder?: GridBorder;
  /**
   * セルの結合（Experimental 0.x・DD-064）。左上のセル（`rowId`・`columnId`）と行数・列数（`rowSpan`・`columnSpan`・
   * 省略は 1）で範囲を指定すると、1 つのセルとして描く（値・背景・状態表示は左上のセル。範囲の中の罫線は描かない）。
   * 両モード共通・**view-local**（文書・Operation・cell-commit・Undo は変わらない。全クライアントの設定一致は利用側責務）。
   * mount 時の値は初期値で、実行中は `GridInstance.setMergedCells` で置き換える。
   * - **読むだけ**: 範囲の中は編集開始（印字キー・F2・ダブルクリック・IME）・Delete／Backspace・選択式の候補欄・日付の
   *   カレンダーを開かない。貼り付け・範囲の消去・cut は範囲のセルだけ飛ばす（`readOnlyColumns` と同じ）。
   * - **選択・移動**: 範囲の中を選ぶと左上を選び、枠は範囲全体に出る。矢印キー・Tab・Enter は範囲を 1 つのセルとして動く。
   *   範囲の選択（Shift＋矢印・ドラッグ）は結合を含むまで広がる。コピーは左上に値・残りは空。
   * - **張る時**: 次の描画の時に、その時の行の並びで範囲に入る行の ID を覚えて張る（範囲の上下に行が入っても一緒に動く）。
   *   左上の行が無い・下に行が足りない間は張らずに診断 warn（`merged-cell-unresolved`）を 1 回出し、行が届けば張る。
   *   固定行の境界をまたぐ・先の指定と重なる範囲は描かない（`merged-cell-conflict`）。範囲の行が欠けた・間に行が入った
   *   範囲は捨てる（`merged-cell-broken`・`setMergedCells` で指定し直すと張る）。
   * - **固定行**: `frozenRowCount` の既定は 1（先頭のデータ行が固定）。先頭の行から結合するときは `frozenRowCount: 0` にする。
   * - 形の誤り（未知の列・右端を越える・固定列の境界をまたぐ・1×1・span が 1 以上の整数でない・同じ左上の重複）は mount 時に
   *   `error`（phase=`config`・code=`merged-cells-invalid`）で fail-fast する。契約: doc/DD/DD-064/contract.md
   */
  readonly mergedCells?: readonly GridMergedCell[];
  /**
   * 2段の見出し（Experimental 0.x・DD-064）。列のまとまり（`caption` と `columnIds`）を指定すると見出しを 2 段にし、
   * 上の段にまとまりの名前、下の段にまとめた列の名前を出す（まとめていない列は 2 段ぶんの高さに名前）。両モード共通・
   * mount 時固定・**view-local**（描画だけ）。上の段のクリックは `header-click` を出さない。
   * - 列は `columnOrder` で隣り合うこと・まとまり同士が同じ列を持たないこと・固定列の境界をまたがないこと。
   * - 形の誤りは mount 時に `error`（phase=`config`・code=`column-display-invalid`）で fail-fast する（`columnCaptions` と同じ経路）。
   */
  readonly columnGroups?: readonly GridColumnGroup[];
  /**
   * 列の見出しの印（Experimental 0.x・DD-070-6・初期値）。ColumnId → `{ sort?: 'asc' | 'desc', filter?: 'available' | 'active' }`。
   * 見出しの右端に、右から絞り込みのボタン、その左に並べ替えの三角を描く（名前は印を除いた幅の中央・収まらなければ省略）。
   * view-local・両モード共通。実行中は `GridInstance.setColumnHeaderMarks` で丸ごと置き換える。並べ替え・絞り込みそのものは行わない
   * （consumer が行い、印で見せる）。不正な項目・未知の列はその項目だけ捨てて診断 warn（`column-header-mark-invalid`）。
   */
  readonly columnHeaderMarks?: Readonly<Record<string, GridColumnHeaderMark>>;
  /**
   * 列のまとまりの開閉の印（Experimental 0.x・DD-070-6・初期値）。まとまりの `id`（省略時は `caption`）→ `{ collapsed }`。
   * 印のあるまとまりは上の段の名前の左に ▾（開いている）／▸（閉じている）を描く。実行中は `setColumnGroupMarks`。
   */
  readonly columnGroupMarks?: Readonly<Record<string, GridColumnGroupMark>>;
  /**
   * 隠す列（Experimental 0.x・DD-070-7・初期値）。ColumnId の配列。隠した列は列の並びと番号を変えずに幅 0 で残す（Excel と同じ）
   * ので、2 段の見出し・罫線・結合・固定列数・列ごとの設定はそのまま効く。クリック・ドラッグ・列幅の境界は見えている列だけ。
   * 選択中のセルが隠した列に入ったら動いてきた向きの次の見えている列へ寄せる。範囲の選択・コピー・貼り付けは Excel と同じく
   * 隠した列を含む。view-local・両モード共通。実行中は `GridInstance.setHiddenColumns`。未知の列は捨てて診断 warn（`hidden-columns-invalid`）。
   */
  readonly hiddenColumns?: readonly string[];
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
  /**
   * 編集対象ドキュメント ID。未指定なら /config の documentId（サーバーの既定文書）を使う。
   * DD-043: 指定すると `/config?documentId=...`・`/ws?documentId=...` としてサーバーへ**文書を名乗る**
   * （複数文書 serve の年度別 board 等）。サーバーが serve していない ID なら boot は config error で止まる。
   */
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
   * 単独グリッドモード（DD-052-4 RC4）で行単位の部分更新を行う。`setData` と違い**渡した行だけ**を置換・追加し、
   * 言及しなかった既存行はそのまま（Undo/Redo 履歴も消さない）。既存行は `cells` に含めた列だけを診断し、値が
   * 変わったセルだけを 1 回の確定操作として記録する（値が同じセルは触れない＝無駄な Undo エントリを作らない）。
   * 未知の RowId は新規行として末尾へ追加する（新規行の挿入自体は `insertRows` と同様 Undo/Redo 対象外）。
   * `readOnlyColumns` は明示した行だけ置き換わる（省略した行は既存の指定を保つ）。列（`readOnlyColumns` mount
   * オプション）・行（`readOnlyRows`）・セル単位いずれの読み取り専用も `setData` と同様にバイパスして適用する
   * （consumer によるプログラム的な再注入のため）。共同編集モードで呼ぶと no-op（診断 warn）。boot 未完了時は
   * `setData` と同様に保留し、呼ばれた順に構築後適用する。
   */
  setRows(rows: readonly GridStandaloneRow[]): void;
  /**
   * セルの状態表示（`GridCellStatus`・DD-060）を付け外しする（Experimental 0.x・DD-062・**両モード共通**）。
   * 渡した行の状態を丸ごと置き換え、`{}` で消す（単独モードの `setRows` の `cellStatus` と同じ決まり・同じ置き場）。
   * 状態は各クライアントの画面だけに持つ（view-local）。サーバーへ送らず、他の参加者には共有しない。文書・Undo・
   * cell-commit・コピーの対象外。未知の RowId（まだ届いていない行）も受け付け、行が現れれば描く。解決できない列は描かない。
   * 単独モードの `setData` は状態も含めて作り直す。boot 前に呼んでもよい（単独モードは `setData`/`setRows` と同じ順で適用）。
   */
  setCellStatus(rows: readonly GridCellStatusRow[]): void;
  /**
   * セルごとの背景色を付け外しする（Experimental 0.x・DD-069・**両モード共通**・view-local）。渡した行の背景を丸ごと置き換え、
   * `{}` で消す（単独モードの `setRows` の `cellBackgrounds` と同じ決まり・同じ置き場）。サーバーへ送らず、文書・Undo・
   * cell-commit・コピーの対象外。未知の RowId（まだ届いていない行）も受け付け、行が現れれば描く。解決できない列は描かない。
   * 単独モードの `setData` は背景も含めて作り直す。boot 前に呼んでもよい（`setCellStatus` と同じく呼んだ順で適用）。
   */
  setCellBackgrounds(rows: readonly GridCellBackgroundRow[]): void;
  /**
   * セルの結合を丸ごと置き換える（Experimental 0.x・DD-064・**両モード共通**・view-local）。`[]` で全部外す。
   * 同じ内容でも、次の描画の時の行の並びで張り直す（壊れて捨てた結合も、指定し直せば張る）。結合を張るのは次の描画の時なので、
   * `setData`（単独モード）と同じ処理の中ならどちらを先に呼んでもよい。**同期 throw しない**（既存の命令と同じ）: 形の誤りの
   * 指定だけ捨てて診断 warn（code=`merged-cells-invalid`）を出し、残りは張る（配列でなければ何も変えない）。
   * boot 前に呼んでもよい（最後に呼んだものが勝つ）。destroy 後は何もしない。読み取り専用でも使える（表示の設定）。
   */
  setMergedCells(mergedCells: readonly GridMergedCell[]): void;
  /**
   * 列の見出しの印を丸ごと置き換える（Experimental 0.x・DD-070-6・両モード・view-local）。`{}` で全部消す。開き直さない。
   * boot 前に呼んでもよい。**同期 throw しない**: 不正な項目・未知の列はその項目だけ捨てて診断 warn（`column-header-mark-invalid`）。
   */
  setColumnHeaderMarks(marks: Readonly<Record<string, GridColumnHeaderMark>>): void;
  /**
   * 隠す列を丸ごと置き換える（Experimental 0.x・DD-070-7・両モード・view-local）。`[]` で全部見せる（元の幅に戻る）。開き直さない
   * （スクロール位置・選択・Undo を保つ）。boot 前に呼んでもよい。**同期 throw しない**: 未知の列は捨てて診断 warn
   * （`hidden-columns-invalid`）、配列でなければ何も変えない。保存する列幅（`layout` の `columnWidths`）には 0 を入れない。
   */
  setHiddenColumns(columnIds: readonly string[]): void;
  /**
   * 見せる行と並びを置き換える（Experimental 0.x・DD-070-8・view-local・開き直さない）。`rowIds` は見せる行を見せる順（並べ替えは
   * 全部の行を並べ替えて渡す・絞り込みは残す行だけ渡す）、`null` で文書の並びに戻す（全部見せる）。並べ替え・絞り込みの計算は
   * consumer が行う（`getRows` で値を読む）。一度きりの並び（Excel と同じ）: 値を変えても並び直さない。
   * - 呼んだ時点にあった行で渡さなかった行は隠す。呼んだ後にできた行は、文書の並びで一つ前の見えている行のすぐ後に見せる
   * - 範囲の操作（選択・コピー・切り取り・範囲の消去・貼り付け・Ctrl+D）は見えている行だけ。隠した行の値は文書に残る（`getRows` で読める）
   * - 選択は行 ID を追う（選択中の行を隠したら近くの見えている行へ）。固定行は見せる並びの先頭の n 行。行をまたぐ結合は張れなくなる
   * - 編集中に呼んだら編集中のセルを確定してから変える。IME の変換中なら変換が終わってから
   * - **同期 throw しない**: 配列でも null でもない・文字列でない要素を含むなら何も変えずに診断 warn（`row-view-invalid`）。
   *   文書に無い行 ID は除いて反映する（warn）。重複は最初の 1 つ
   */
  setRowView(rowIds: readonly string[] | null): void;
  /** 今見せている行を見せる順に返す（Experimental 0.x・DD-070-8。CSV を「見えているとおり」に作る材料）。boot 前・destroy 後は []。 */
  visibleRowIds(): readonly string[];
  /** 列のまとまりの開閉の印を丸ごと置き換える（Experimental 0.x・DD-070-6・両モード・view-local）。`{}` で全部消す。 */
  setColumnGroupMarks(marks: Readonly<Record<string, GridColumnGroupMark>>): void;
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
  /**
   * 指定行を可視域へ入れる（Experimental 0.x・DD-035 R6・両モード）。行が body viewport の外にあれば最小スクロールで
   * 可視化し（スクロールバーを除く領域。Excel の scroll-follow と同じ）、既に可視なら何もしない（横スクロールは動かさない）。`setData` 再注入・
   * `insertRows` の**直後**に新 RowId で呼んでも同期で成立する（行 Axis 未再構築なら、その場で再構築してから適用する）。
   * boot 未完了・初回描画前だけは保留して初回描画後に適用する（保留中はキー入力を遮断）。
   * 未知 RowId（tombstone・未注入）は診断 warn（code=`scroll-row-unknown`）のみで no-op
   * （文書 Operation ではないため `rejected` は出さない・同期 throw しない）。
   */
  scrollToRow(rowId: string): void;
  /**
   * 指定列を可視域へ入れる（Experimental 0.x・DD-036 C4・両モード）。`scrollToRow` の鏡像で、列が body viewport の
   * 外にあれば最小スクロールで可視化し、既に可視なら何もしない（**縦スクロールは動かさない**）。固定列
   * （index < `frozenColumnCount`）は常に可視のため無変更。構造変更（`setData`/行挿入削除）直後の保留・同期 flush は
   * `scrollToRow` と同じ機構を共有する。未知 ColumnId は診断 warn（code=`scroll-column-unknown`）のみで no-op。
   */
  scrollToColumn(columnId: string): void;
  /**
   * アクティブセルを指定セルへ移して可視化する（Experimental 0.x・DD-035 R6・両モード）。セルクリックと同じ経路を通る:
   * 明示レンジは解除、編集中なら確定して移動、IME 変換中は変換確定後に移動（pendingNavigation）、開いている選択式/日付
   * ポップアップは閉じ、**常駐 textarea へフォーカスする**（「行を追加」ボタン → 追加行へ入力開始、の用途）。
   * `scrollToRow` と同じく構造変更直後でも同期で成立する（呼び出しから戻った時点で activeCell が移っている）。未知 RowId/ColumnId は診断 warn
   * （code=`active-cell-unknown`）のみで no-op。readOnly でも動く（閲覧系）。
   */
  setActiveCell(rowId: string, columnId: string): void;
  /**
   * 現在の参加者一覧（Experimental 0.x・DD-049 H5）。直近の `presence` イベントの `users` と一致する（先頭に自分・続いて
   * 他者をサーバーから届いた順）。単独グリッドモード・初回 join 前・destroy 後は `[]`。
   * セルを選ばずに参加しただけの利用者も `activeCell: null` で載る（DD-053 H10・「参加」＝join 完了時点）。
   */
  presences(): readonly GridPresenceUser[];
  /**
   * 今の選択（Experimental 0.x・DD-070-2・両モード）。`selection-change` イベントと同じ形で、呼んだ時点の選択を返す
   * （イベントは描画のループで出るため、直前の操作の結果はイベントより先にここへ現れる）。行が無い・boot 前・destroy 後は両方 null。
   */
  selection(): GridSelection;
  /**
   * 表のデータを読む（Experimental 0.x・DD-070-5・両モード）。文書の並びで全部の行（削除した行は除く）を `{ rowId, cells }` で返す
   * （`cells` は ColumnId → 表示文字列・空のセルは無し＝`setData` の行と同じ形で、そのまま渡せば同じ表になる。数値は桁区切りなし・
   * 日付は `YYYY-MM-DD`）。値は自分の未確定の変更を含む今の値（編集中のセルの下書きは含めない）。共同編集モードでは他の参加者の
   * 確定も含む。`options.columnIds`・`rowIds` で絞れる（大きい表では並べ替えのキーの列だけを読むと軽い）。画面だけの並べ替え・
   * 絞り込み（DD-070-8）の影響は受けない。同期で返す（`setData` の直後に読めば新しい行）。boot 前・destroy 後と、共同編集で
   * サーバーの初回の状態を受け取る前は `[]`。返すのは行 ID とセルの値だけで、行データの `readOnlyColumns`・`cellStatus`・
   * `cellBackgrounds` は含まない（`setData` に戻すときは consumer が合成する。単独モードの `setData` はそれらを作り直す）。
   */
  getRows(options?: GridReadRowsOptions): readonly GridRowData[];
  /**
   * 表示専用モード（`readOnly`）を実行中に切り替える（Experimental 0.x・DD-056 H12・両モード）。**開き直さない**: 共同編集セッション・
   * 未送信の操作・スクロール位置・選択・列幅を保ち、未送信の操作は通常どおりサーバーへ届く（拒否されれば `rejected`）。
   * - `true`: 編集中のセルは「確定して移動しない」で確定してから切り替える（入力を捨てない。変換を確定した直後の状態も確定する）。
   *   開いている選択式・日付の候補欄は閉じる（未確定の選択は捨てる）。**IME 変換中**は textarea に触れず、文書を変える他の入口
   *   （貼り付け・行操作・Undo/Redo・候補欄・API の `insertRows` 等）はすぐに止め、変換が終わってから編集中のセルを確定して切り替える。
   * - `false`: すぐに編集可能へ戻す（変換の終わり待ちの切り替えは取り消す）。`readOnlyColumns`・`readOnlyRows` は従来どおり効く。
   * 抑止・維持する操作は mount オプション `readOnly` と同じ。同値・destroy 後は何もしない。権限制御ではない（サーバーで書込を
   * 拒否するのは server-hono の `authorizeOperation`）。
   */
  setReadOnly(readOnly: boolean): void;
  /**
   * 自分の未確定の操作の数（Experimental 0.x・DD-056 H12）。サーバーで受理も拒否もまだされていない操作（ACK 済みで確定の配信待ちを
   * 含む）。変化は `pending` イベントでも届く。単独グリッドモード・boot 前・destroy 後は 0。
   */
  pendingCount(): number;
  /**
   * 送り切るまで待つ（Experimental 0.x・DD-056 H12・両モード）。呼んだ時点の編集中のセルを確定し（変換を確定した直後の状態も確定する。
   * IME 変換中なら変換が終わるのを待つ）、自分の未確定の操作が 0 になったら `{ status: 'flushed' }` で解決する。提出・締切などの
   * 状態を変える操作の前に呼ぶ想定。オフラインなら再接続して送り切るのを待つ（上限 `timeoutMs`・既定 10,000ms を過ぎたら `timeout`）。
   * 送り切れないまま接続が終端・destroy されたら `stopped`。待つ間に自分が入力を続けると pending が 0 にならず待ち続ける。
   * 単独グリッドモードは確定してすぐ `flushed`。複数回呼んでよい。Promise は reject しない。
   */
  flush(options?: GridFlushOptions): Promise<GridFlushResult>;
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
