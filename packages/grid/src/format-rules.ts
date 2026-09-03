// format-rules（DD-027-3・セル書式モデル）: 利用側供給の「値→書式マッピング」を mount 時に
// プリコンパイルする純関数モジュール（DOM 非依存＝TDD 対象）。
//
// 【設計方針（親 DD-027 決定④⑤／DD-027-3 📐）】
//   - 書式は **view-local**（値ベース＝同じ表示値なら同じ見た目・利用側配布の設定に依存）。文書状態（CellScalar・
//     hash・snapshot・protocol）は一切変更しない。設定が一致していれば全クライアントで実質同一表示になる（設定
//     不一致クライアントは異なる装飾を見る＝共有化設計文書 `doc/plan/cell-format-sharing-design.md` に明記）。
//   - 一致条件は **v1 では完全一致のみ**（`match: string | string[]`＝セル表示文字列の完全一致）。列→値→style の
//     Map へプリコンパイルし、描画ホットパスでは O(1) lookup にする（ルールの線形走査を描画時にしない）。
//   - 書式は **非空セルのみ**に付く（値ベース）。列全体の静的背景色（値によらない列色）は v1 対象外。
//   - 公開面は宣言的 mount オプション `columnFormats` のみ（index.ts）。registry 相当の登録 API は公開しない（決定⑤）。
//
// 【拡張点メモ（P-07 材料・DD-027-3 検討内容）】
//   本 v1 は `match` を「表示文字列の完全一致」に限定する。将来「値レンジ（数値比較）・正規表現・利用側 callback」が
//   複数実案件で要求されたら、`match` を `string | string[] | { range } | RegExp | (value)=>boolean` へ拡張する
//   I/F 案が候補になる（実装しない）。callback 形は「描画 Plugin のフレーム予算契約」（憲章 §13.2）を要するため
//   P-07 判断ゲートの材料に留める。列全体の静的背景色も同経路で追加する（共有化設計文書の拡張方針に従う）。
//
// 【R7 注意】本モジュールは公開型（GridColumnFormatRule/GridCellFormatStyle）を定義するため index.ts から到達可能
//   ＝公開宣言 closure に含まれる（facade-surface contract）。内部 package（render 等）を import すると R7 違反に
//   なるため import しない。base-layer の描画契約型 ResolvedCellStyle とは**構造同一**（4 つの任意フィールド）で、
//   mount-controller が getStyle() の戻り値（GridCellFormatStyle）をそのまま base-layer.getCellStyle へ渡せる
//   （構造的部分型で相互代入可能）。

/**
 * セル書式スタイル（公開・宣言的）。すべて任意。色文字列（CSS color）は検査しない（canvas fillStyle は不正値を
 * 無視＝安全）。`badge:true` のとき値を丸角チップ（バッジ）として描く（`badgeColor` はチップ背景色・既定は
 * `cellBackground` 系）。`textColor` は文字色（数値既定色より優先・右寄せは維持）。
 */
export interface GridCellFormatStyle {
  /** セル背景色（CSS color・罫線は保存＝罫線幅ぶん inset して塗る）。 */
  readonly cellBackground?: string;
  /** 文字色（CSS color・数値既定色より優先）。 */
  readonly textColor?: string;
  /** true=値を丸角チップ（バッジ）で描画（右隣へオーバーフローしない）。 */
  readonly badge?: boolean;
  /** チップ背景色（`badge:true` 時。既定は `cellBackground` 系）。 */
  readonly badgeColor?: string;
}

/**
 * 書式ルール（公開・宣言的）。`match` はセル表示文字列の**完全一致**（v1。範囲・正規表現・callback は拡張点メモ）。
 * `style` は一致セルへ適用する装飾。同一列内で同じ match 値を複数ルールが指定すると mount 時に fail-fast する。
 */
export interface GridColumnFormatRule {
  /** 一致対象のセル表示文字列（完全一致・単一 or 複数）。 */
  readonly match: string | readonly string[];
  /** 一致セルへ適用する装飾。 */
  readonly style: GridCellFormatStyle;
}

/**
 * columnFormats 設定の不正を fail-fast で通知する内部エラー（AC8）。mount-controller が catch して公開
 * `error`（phase=config・**安定 code**=column-types-invalid）へ写像する（ColumnTypeConfigError と同経路・
 * 27-1 の写像を流用）。`message` はそのまま公開 error の `message` として渡す（columnFormats は利用側が与える
 * 設定値＝機微情報でない・違反列/値を含め開発者が原因を特定できるようにする）。公開されるのは安定 code のみ。
 */
export class FormatRuleConfigError extends Error {
  constructor(
    /** 機械可読な理由（診断用・公開はしない）。 */
    readonly reason: 'unknown-column' | 'empty-rules' | 'empty-match' | 'duplicate-match',
    /** 対象列 ID（診断用）。 */
    readonly columnId: string,
    message: string,
  ) {
    super(message);
    this.name = 'FormatRuleConfigError';
  }
}

/** プリコンパイル済みの書式解決器（列→値→resolved style の O(1) lookup・base-layer の getCellStyle が束縛する）。 */
export interface CompiledColumnFormats {
  /**
   * 列 ID・表示値に一致する解決済み style（無ければ undefined）。描画ホットパスの O(1) lookup。戻り値は
   * base-layer の ResolvedCellStyle と構造同一ゆえ getCellStyle へそのまま渡せる（R7: render 型を import しない）。
   */
  getStyle(columnId: string, value: string): GridCellFormatStyle | undefined;
  /** 書式ルールが 1 つでもあるか（base-layer への束縛要否＝無ければ描画コスト増ゼロ）。 */
  hasAny(): boolean;
}

/** GridCellFormatStyle を解決する（定義フィールドのみコピー・freeze＝不変）。 */
function resolveStyle(style: GridCellFormatStyle): GridCellFormatStyle {
  const resolved: {
    cellBackground?: string;
    textColor?: string;
    badge?: boolean;
    badgeColor?: string;
  } = {};
  // 注: 出力は GridCellFormatStyle（公開型・render の ResolvedCellStyle と構造同一）。
  if (style.cellBackground !== undefined) {
    resolved.cellBackground = style.cellBackground;
  }
  if (style.textColor !== undefined) {
    resolved.textColor = style.textColor;
  }
  if (style.badge !== undefined) {
    resolved.badge = style.badge;
  }
  if (style.badgeColor !== undefined) {
    resolved.badgeColor = style.badgeColor;
  }
  return Object.freeze(resolved);
}

/**
 * columnFormats（mount オプション）と columnOrder から書式解決器をプリコンパイルする（fail-fast・AC8）。
 * columnFormats 未指定/空なら「書式なし」解決器を返す（現行描画と完全一致・AC3）。
 * 不正設定（未知列・空ルール配列・空 match〔空配列/空文字〕・同一列内の match 重複）は FormatRuleConfigError を throw する。
 *
 * `match` は表示文字列の完全一致。列内で同じ match 値を複数ルールが指定するのは曖昧（どの style を採るか不定）
 * ゆえ mount 時に fail-fast する（先勝ちで黙って握り潰さない＝サイレント破壊の禁止）。
 */
export function compileFormatRules(
  columnFormats: Readonly<Record<string, readonly GridColumnFormatRule[]>> | undefined,
  columnOrder: readonly string[],
): CompiledColumnFormats {
  const byColumn = new Map<string, Map<string, GridCellFormatStyle>>();
  const columnSet = new Set(columnOrder.map((c) => String(c)));

  if (columnFormats !== undefined) {
    for (const [columnId, rules] of Object.entries(columnFormats)) {
      if (!columnSet.has(columnId)) {
        throw new FormatRuleConfigError(
          'unknown-column',
          columnId,
          `columnFormats: 未知の列 "${columnId}"（columnOrder に存在しない）`,
        );
      }
      if (rules.length === 0) {
        throw new FormatRuleConfigError(
          'empty-rules',
          columnId,
          `columnFormats: 列 "${columnId}" のルール配列が空`,
        );
      }
      const valueMap = new Map<string, GridCellFormatStyle>();
      for (const rule of rules) {
        const matches = typeof rule.match === 'string' ? [rule.match] : rule.match;
        // 空の match（空配列・空文字）は「死にルール」＝黙って無効化せず fail-fast する（Fable P2）。描画は非空セル
        // のみゆえ空文字は永遠に一致せず、空配列は効果ゼロなのに hasAny を true にして cheap path（AC3）を壊す。
        if (matches.length === 0) {
          throw new FormatRuleConfigError(
            'empty-match',
            columnId,
            `columnFormats: 列 "${columnId}" に空の match 配列（一致対象がない死にルール）`,
          );
        }
        const resolved = resolveStyle(rule.style);
        for (const value of matches) {
          if (value === '') {
            throw new FormatRuleConfigError(
              'empty-match',
              columnId,
              `columnFormats: 列 "${columnId}" に空文字の match（非空セルにしか書式は付かず永遠に一致しない）`,
            );
          }
          if (valueMap.has(value)) {
            throw new FormatRuleConfigError(
              'duplicate-match',
              columnId,
              `columnFormats: 列 "${columnId}" に重複する match 値 "${value}"（どの style を採るか曖昧）`,
            );
          }
          valueMap.set(value, resolved);
        }
      }
      byColumn.set(columnId, valueMap);
    }
  }

  const hasAny = byColumn.size > 0;
  return {
    getStyle: (columnId, value) => byColumn.get(columnId)?.get(value),
    hasAny: () => hasAny,
  };
}
