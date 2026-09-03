// column-types（DD-027-1・grid 層の列タイプメタ）: 公開型・Internal な ColumnTypeRegistry・editor 経路の
// commit 前 validator を定義する純関数モジュール（DOM 非依存＝TDD 対象）。
//
// 【設計方針（親 DD-027 決定①②⑤／DD-027-1 📐）】
//   - core の CellScalar・protocol・snapshot は変更しない。列タイプは **grid 層のメタ**（値は string のまま）。
//   - 候補は **列ごとの静的リスト**。検証は **editor 経路の commit 直前だけ**（chokepoint 全体ではない）。
//     paste/setData/リモート由来の非候補値は本 validator を通らない＝保持・表示される（決定②「拒否しない」）。
//   - registry は **Internal**（consumer 向け登録 API は公開しない・決定⑤）。公開面は宣言的 mount オプション
//     `columnTypes` のみ（index.ts）。本モジュールの registry 形は P-07（Plugin API v1）判断材料の土台。
//
// 【拡張点メモ（動的供給・P-07 材料・DD-027-1 検討内容）】
//   本 v1 は候補を `readonly options: readonly string[]`（静的）で受ける。将来「動的供給」（列の候補を
//   callback/Promise で解決する・依存列で候補が変わる等）が複数実案件で要求されたら、`GridSelectColumnType`
//   の `options` を `options | (ctx) => options | Promise<options>` へ拡張する I/F 案が候補になる（実装しない）。
//   その場合 validator は非同期化を避けるため「開いた時点の解決済み候補スナップショット」で検証する設計になる。

import { parseCellInput } from '@nanairo-sheet/core';

import { cellScalarToDisplay } from './document-view';

/** 選択式入力列（ドロップダウン制約・DD-027-1）。値は表示文字列で round-trip する（決定⑥）。 */
export interface GridSelectColumnType {
  readonly type: 'select';
  /** 静的候補リスト（1 件以上・重複不可＝mount 時 fail-fast）。表示順＝ドロップダウンの並び。 */
  readonly options: readonly string[];
  /**
   * 自由入力の許可（既定 false）。false のとき editor 経路（IME/textarea 確定・ドロップダウン）で候補外の値は
   * commit されない（`value-not-allowed` 通知＋文書無変更）。true なら候補外も従来どおり確定できる（AC5）。
   * いずれの場合も paste/setData/リモート由来の非候補値は保持される（validator を通らないため・決定②）。
   */
  readonly allowFreeText?: boolean;
}

/**
 * ハイパーリンク列（クリックで `link-open` イベント通知・DD-027-2）。値は string 1本（表示テキスト＝URL または任意
 * テキスト・親③）。クリック（押下→同一セルで離す）で `link-open{rowId,columnId,value}` が発火し activeCell も移動する
 * （選択を奪わない）。**SDK は navigate しない**のが既定。描画はリンク色＋下線・自セル内クリップ（オーバーフローしない）。
 * ドラッグ選択・Shift+クリック・キーボード・タッチではリンクを起動しない（対象外・DA の逃げ道）。編集は F2/直接入力/IME を維持。
 */
export interface GridLinkColumnType {
  readonly type: 'link';
  /**
   * 既定 open（opt-in・既定 false・親③「提供する場合」）。true のとき `link-open` 発火に加えて SDK が
   * **絶対 http/https URL のみ** `window.open(value, '_blank', 'noopener,noreferrer')` で開く。
   * javascript:/data:/相対/非URL は open せず診断 warn（`link-open` イベント自体は成否に関わらず常に発火）。
   */
  readonly defaultOpen?: boolean;
}

/**
 * 列タイプの union（Experimental 0.x）。選択式（DD-027-1）とハイパーリンク（DD-027-2）。書式（DD-027-3）は別チャネル
 * （描画）で扱う想定のため本 union には加えない見込み。type 判別子で分岐する（registry が type 別に参照系を提供）。
 */
export type GridColumnType = GridSelectColumnType | GridLinkColumnType;

/**
 * 絶対 http/https URL か（defaultOpen の open 可否・DD-027-2 決定・純関数＝TDD 対象）。`new URL(value)` がパースでき
 * protocol が http:/https: のときだけ true。相対 URL・非 URL 文字列・`javascript:`/`data:`/`file:` 等は false
 * （open せず診断 warn・link-open は別途常に発火）。base を渡さないため相対 URL は URL 構築に失敗＝false になる。
 */
export function isAbsoluteHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * columnTypes 設定の不正を fail-fast で通知する内部エラー（AC8）。mount-controller が catch して公開
 * `error`（phase=config・**安定 code**=column-types-invalid）へ写像する。`message` は GridBootError と同様に
 * そのまま公開 error の `message` として渡す（columnTypes は利用側が与える設定値＝機微情報でない・開発者が原因を
 * 特定できるよう違反列/候補/正規化後表示を含める）。公開されるのは安定 code のみで、内部 `reason` enum は露出しない。
 */
export class ColumnTypeConfigError extends Error {
  constructor(
    /** 機械可読な理由（診断用・公開はしない）。 */
    readonly reason:
      | 'unknown-column'
      | 'unsupported-type'
      | 'empty-options'
      | 'duplicate-options'
      | 'option-not-round-trip'
      | 'wrap-link-conflict',
    /** 対象列 ID（診断用）。 */
    readonly columnId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ColumnTypeConfigError';
  }
}

/** editor 経路の commit 前検証の結果（サイレント失敗を避けるため拒否値・列を持つ）。 */
export interface EditorCommitValidation {
  /** commit してよいか（false=未 submit＋通知）。 */
  readonly allowed: boolean;
  readonly columnId: string;
  /** 検証対象の表示文字列（拒否時の通知に含める＝DD-027-1 AC4「拒否値を含む」）。 */
  readonly value: string;
}

/** 列タイプの参照・検証を提供する Internal registry（consumer へは公開しない・決定⑤）。 */
export interface ColumnTypeRegistry {
  /** 列の型（未設定列は undefined）。 */
  getColumnType(columnId: string): GridColumnType | undefined;
  /** 選択式列か。 */
  isSelectColumn(columnId: string): boolean;
  /** ハイパーリンク列か（DD-027-2・クリック裁定・描画・hover cursor の列単位判定）。 */
  isLinkColumn(columnId: string): boolean;
  /** ハイパーリンク列の型（リンク列でなければ undefined）。defaultOpen の参照に使う（DD-027-2）。 */
  getLinkType(columnId: string): GridLinkColumnType | undefined;
  /** 選択式列の候補（選択式でなければ undefined）。 */
  getSelectOptions(columnId: string): readonly string[] | undefined;
  /** その列で自由入力が許可されているか（非選択式列は true＝制約なし）。 */
  allowsFreeText(columnId: string): boolean;
  /**
   * editor 経路（IME/textarea 確定）の commit 前検証。非選択式列・`allowFreeText:true` 列・空文字（クリア）は
   * 常に許可。選択式（`allowFreeText:false`）は候補一致のみ許可。**この関数は editor 経路だけが呼ぶ**
   * （paste/setData/リモートは通さない＝決定②）。
   */
  validateEditorCommit(columnId: string, value: string): EditorCommitValidation;
  /** 選択式列が 1 つでもあるか（ドロップダウン UI の配線要否判定）。 */
  hasAnySelectColumn(): boolean;
  /** ハイパーリンク列が 1 つでもあるか（hover cursor の cheap path 縮退判定・DD-027-2）。 */
  hasAnyLinkColumn(): boolean;
}

/**
 * columnTypes（mount オプション）と columnOrder から Internal registry を生成する（fail-fast・AC8）。
 * columnTypes 未指定/空なら「型なし」registry を返す（現行挙動＝全列自由入力・AC7）。
 * 不正設定（未知列・未対応 type・候補 0 件・候補重複・リンク×折り返し併用）は ColumnTypeConfigError を throw する。
 *
 * @param wrapColumns 折り返し（wrap）列（ColumnId 文字列）。リンク列と併用は描画契約が両立しないため fail-fast
 *   （DD-027-2 検討内容・wrap-link-conflict）。未指定なら併用検査をしない（DD-027-1 の呼び出しと後方互換）。
 */
export function createColumnTypeRegistry(
  columnTypes: Readonly<Record<string, GridColumnType>> | undefined,
  columnOrder: readonly string[],
  wrapColumns?: Iterable<string>,
): ColumnTypeRegistry {
  const types = new Map<string, GridColumnType>();
  const columnSet = new Set(columnOrder.map((c) => String(c)));
  const wrapSet = new Set<string>(wrapColumns === undefined ? [] : [...wrapColumns].map((c) => String(c)));

  if (columnTypes !== undefined) {
    for (const [columnId, type] of Object.entries(columnTypes)) {
      if (!columnSet.has(columnId)) {
        throw new ColumnTypeConfigError(
          'unknown-column',
          columnId,
          `columnTypes: 未知の列 "${columnId}"（columnOrder に存在しない）`,
        );
      }
      // 対応 type は 'select'（DD-027-1）・'link'（DD-027-2）。将来 type が増えたらここへ分岐を足す。
      if (type.type !== 'select' && type.type !== 'link') {
        throw new ColumnTypeConfigError(
          'unsupported-type',
          columnId,
          `columnTypes: 列 "${columnId}" の未対応 type "${(type as { type: string }).type}"`,
        );
      }
      if (type.type === 'link') {
        // DD-027-2: リンク列は wrap（折り返し・自動行高）と描画契約が両立しない（単行 fitText・下線 vs 複数行）。
        // mount 時に fail-fast し、要求が出たら描画契約を定義して解除する（検討内容・最小・誠実）。
        if (wrapSet.has(columnId)) {
          throw new ColumnTypeConfigError(
            'wrap-link-conflict',
            columnId,
            `columnTypes: リンク列 "${columnId}" は wrapColumns（折り返し）と併用できない`
              + `（単行リンク描画と複数行折り返しの描画契約が両立しないため・DD-027-2）`,
          );
        }
        types.set(columnId, type);
        continue;
      }
      if (type.options.length === 0) {
        throw new ColumnTypeConfigError(
          'empty-options',
          columnId,
          `columnTypes: 選択式列 "${columnId}" の候補が 0 件`,
        );
      }
      const seen = new Set<string>();
      for (const option of type.options) {
        if (seen.has(option)) {
          throw new ColumnTypeConfigError(
            'duplicate-options',
            columnId,
            `columnTypes: 選択式列 "${columnId}" に重複候補 "${option}"`,
          );
        }
        seen.add(option);
        // 決定⑥ round-trip 保証（Fable 5 P2）: 候補が parseCellInput→cellScalarToDisplay で自己 round-trip しないと、
        // 本人が選んでも editorSubmit（表示文字列比較）で拒否され、confirmSelect の parse で保存表示が変わる
        // （例 "1,000"→1000・"01"→"1"）。mount 時に fail-fast し、違反候補と正規化後表示を message に含める。
        const normalized = cellScalarToDisplay(parseCellInput(option));
        if (normalized !== option) {
          throw new ColumnTypeConfigError(
            'option-not-round-trip',
            columnId,
            `columnTypes: 選択式列 "${columnId}" の候補 "${option}" は値解釈で "${normalized}" に正規化され round-trip しない`
              + `（数値/日付形の候補は表示と一致しないため使用不可・決定⑥）`,
          );
        }
      }
      types.set(columnId, type);
    }
  }

  const selectOf = (columnId: string): GridSelectColumnType | undefined => {
    const type = types.get(columnId);
    return type !== undefined && type.type === 'select' ? type : undefined;
  };
  const linkOf = (columnId: string): GridLinkColumnType | undefined => {
    const type = types.get(columnId);
    return type !== undefined && type.type === 'link' ? type : undefined;
  };

  let anySelect = false;
  let anyLink = false;
  for (const type of types.values()) {
    if (type.type === 'select') {
      anySelect = true;
    } else if (type.type === 'link') {
      anyLink = true;
    }
  }

  return {
    getColumnType: (columnId) => types.get(columnId),
    isSelectColumn: (columnId) => selectOf(columnId) !== undefined,
    isLinkColumn: (columnId) => linkOf(columnId) !== undefined,
    getLinkType: (columnId) => linkOf(columnId),
    getSelectOptions: (columnId) => selectOf(columnId)?.options,
    allowsFreeText: (columnId) => {
      const select = selectOf(columnId);
      return select === undefined || select.allowFreeText === true;
    },
    validateEditorCommit: (columnId, value) => {
      const select = selectOf(columnId);
      // 非選択式列・自由入力許可・空文字（クリアは常に許可＝ユーザーを閉じ込めない）は通す。
      const allowed =
        select === undefined ||
        select.allowFreeText === true ||
        value === '' ||
        select.options.includes(value);
      return { allowed, columnId, value };
    },
    hasAnySelectColumn: () => anySelect,
    hasAnyLinkColumn: () => anyLink,
  };
}
