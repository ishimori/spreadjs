# CHANGELOG — @nanairo-sheet Alpha

`@nanairo-sheet/*`（Facade `grid` / `server-hono` と内部 package）の変更履歴。

## 運用ルール（S1-5・ADR-0015 D1）

- **成熟度**: Stage 1 は **Experimental `0.x`**。Facade（`grid` / `server-hono`）だけが consumer 公開面。長期後方互換は**非保証**。
- **破壊的変更**: `0.x` では破壊的変更を許すが、**必ず本 CHANGELOG に記録**する（サイレント破壊の禁止）。「破壊的変更」節に列挙する。
- **バージョン検出**: package 版（`0.1.0-alpha.0`）と API 版（`GRID_API_VERSION` / `SERVER_HONO_API_VERSION` = `0.1.0-experimental`）の
  両方で検出可能にする。**API 版は公開シグネチャの契約版**、**package 版は配布物の版**で、対応を本 CHANGELOG に記録する。
- **配布**: pack tarball closure 方式（決定事項A・ADR-0015）。`scripts/release/build-release.sh` が 9 tarball＋manifest（版数・sha256・
  生成コミット・channel）を生成する。channel は `alpha`（registry 非経由のため dist-tag 相当を manifest 表記で代替）。

| package 版 | channel | API 版（grid / server-hono） | 備考 |
|---|---|---|---|
| `0.1.0-alpha.0` | `alpha` | `0.1.0-experimental` | 初回 Alpha 配布（DD-017） |

## [Unreleased]

### Added

- **grid 貼り付け後の選択レンジ（Experimental・DD-038）**: 貼り付けが成立した直後に、**貼付範囲がそのまま選択される**
  （Excel 準拠。松下 生産納期 consumer の「どこに貼られたか分からない」指摘の解消）。利用者はどこへ何行×何列貼られたかを
  画面で確認でき、そのまま Delete で取り消す・貼り直すといった後続操作につなげられる。**公開 API の追加・変更はなく**
  （`.d.ts` snapshot 差分なし）、設定も不要で既定で効く**挙動変更**のみ（→「破壊的変更」節にも記載）。
  - **アクティブセルは貼付矩形の左上へ移る**。これは Excel 準拠であると同時に、選択レンジの不変条件
    （明示レンジは anchor === activeCell の間だけ存在する・DD-020-1）を満たすための要件でもある。右下から左上へ
    ドラッグして範囲選択した状態で貼ると、貼付アンカー（矩形の左上）と activeCell が別セルになるため。
  - **選択されるのは「貼り付け矩形」**であって「実際に書き込まれたセル」ではない。読み取り専用の行・列
    （`readOnlyRows` / `readOnlyColumns`）でスキップされたセルも、jagged な TSV（行ごとに列数が違う）で欠けた
    セルも矩形に含む＝歯抜けの選択にはしない。
  - **文書が変わらなかったときは選択も動かない**: 上限超過・はみ出し・空クリップボード（noop）に加え、
    読み取り専用により**全件スキップ**された場合も、選択・アクティブセルとも一切変更しない（「貼れた」という誤認を作らない）。
  - 1×1 の貼り付けでは明示レンジを作らない（従来どおり単一セル選択のまま＝見た目の変化なし）。
  - cut / copy / 範囲クリア（Delete）の選択挙動、および他クライアントの貼り付けを受信したときの自分の選択は**不変**。
    貼り付け後にリモートで行が挿入・削除された場合の再ベース（DD-021-3）も従来どおり動く。

- **grid 自由入力併存の選択式列（Experimental・DD-037）**: `columnTypes` の `{ type: 'select', options, allowFreeText: true }`
  で「**候補を出しつつ、候補外の値も入力できる**」列を提供する（Excel の入力規則リストでエラー停止を設定しない状態＝
  実務で最も多い使い方。松下 生産納期 consumer 駆動）。`allowFreeText` の意味を **commit 検証の厳格さだけ**に限定し、
  候補 UI の表示可否と分離した（→「破壊的変更」節）。
  - **候補を開く**: ダブルクリック／F2／Enter／Alt+↓（`allowFreeText:false` と同じキー体系）。▼ インジケーターも出る。
    ↑↓ でハイライト → Enter で候補を確定（既存 chokepoint 経由＝Undo・cell-commit・OCC は従来どおり）。
  - **入力中の絞り込み**: 自由入力併存列を**編集中**は、入力（IME 変換中を含む）の**前方一致**で候補リストが自動表示され
    絞り込まれる（大小文字は無視）。**候補 0 件になったら閉じる**＝自由入力の邪魔をしない。
    このリストは**キーを一切奪わない** passive な表示で、印字・IME・キャレット移動・Enter/Tab の確定はすべて従来の
    editor 経路のまま。ハイライトは付かない＝**Enter は入力文字列をそのまま確定する**（候補外でも通る）。
    候補の選択はクリックで行う（編集中の ↑↓ はキャレット移動のまま＝キーボードでの候補選択は Alt+↓ の候補表示から）。
  - editor-state-machine・ime-editing-session・`integration-editor` は**無改変**（I-3 維持）。`validateEditorCommit` も無改変
    （`allowFreeText:true` は従来どおり候補外を通し、`false` は従来どおり `value-not-allowed` で拒否する）。
- **grid 固定行列数 `frozenRowCount` / `frozenColumnCount`（Experimental・DD-036 C1）**: 先頭 n 行 / n 列を
  スクロール時に固定する（マトリクス型シートのラベル列。松下 納入計画 consumer 駆動）。**既定は 1／1**＝
  DD-036 以前のハードコード値と完全一致（未指定の consumer は無影響）。`0` で固定なし。両モード共通・mount 時固定・
  **view-local**（文書状態にしない＝共有化は `cell-format-sharing-design.md` のスコープ）。
  行数/列数を超える指定はクランプ。0 以上の整数以外は診断 `frozen-count-invalid` warn を出して既定 1 へ倒す
  （mount は成功する）。
- **grid 列単位の静的背景色 `columnBackgrounds`（Experimental・DD-036 C2）**: ColumnId→CSS color で**値によらない
  列全体の背景色**（非稼働日の網掛け等）を描く。`columnFormats`（値ベース・非空セルのみ）とは**別経路**で、
  **空セルも塗る**（pane 背景の直後・罫線の前に列バンドとして塗る＝罫線・選択・Presence は上に乗る）。
  同一セルに値ベース書式の背景があれば**値ベースが勝つ**。固定 pane の列にも効く。view-local・mount 時固定。
  未知列・空/空白のみの色は `column-types-invalid` で fail-fast（色文字列の妥当性は検査しない）。
- **grid 読み取り専用行 `readOnlyRows`（Experimental・DD-036 C3）**: RowId 配列で指定した行のセルを編集不可にする
  （`readOnlyColumns` の行版・両方指定なら和）。抑止（入口＝編集開始/Delete/ドロップダウン/カレンダー・常駐 textarea の
  `readOnly` 属性）／範囲スキップ（貼り付け・範囲クリア・cut は指定行だけスキップ＝TSV の行位置不変・診断
  `readonly-row-skipped`）／保証層（submit 直前で op 全体を破棄＝診断 `readonly-row-blocked`）は列版と同型。
  行挿入削除・setData・コピー・リモート受信反映は従来どおり。**未知 RowId は診断 `readonly-row-unknown` warn のみ**
  （行は初期データ到着前に検証できないため列の fail-fast とは扱いを分ける・初回描画後に 1 回判定）。
  **権限制御ではない**（サーバー側強制なし）。新規公開 error/conflict code なし。
- **grid 命令 API `scrollToColumn(columnId)`（Experimental・DD-036 C4）**: 指定列を最小スクロールで可視化する
  （`scrollToRow` の鏡像＝**縦スクロールは動かさない**・可視なら動かない・固定列は常に可視ゆえ無変更）。
  `setData`／行挿入削除の直後でも同期で成立する（DD-035 R6 の保留・同期 flush 機構を共有）。未知 ColumnId は診断
  `scroll-column-unknown` warn のみで no-op。
- **react props 4 点＋handle `scrollToColumn`（Experimental・DD-036）**: props へ `frozenRowCount`／`frozenColumnCount`／
  `columnBackgrounds`／`readOnlyRows`（grid 同名オプションへ 1:1 写像・識別系＝値変更で自動 remount・Record と行 ID 集合は
  キー順/並び順非依存で正準化）、handle へ `scrollToColumn`（未 mount は `handle-before-mount` warn）を追加した。
- **grid 日付列 `columnTypes` の `{ type: 'date', openOn? }`（Experimental・DD-035 R2）**: カレンダーのポップオーバーから
  LocalDate（`YYYY-MM-DD`・ADR-0012）を選んで確定する列タイプ（松下 生産納期 consumer 駆動）。
  - **手入力と併存**: 印字文字キーは従来どおり常駐 textarea の手入力を開始し `2026/7/31` → `2026-07-31` に正準化する
    （型は編集 UI の選択であって入力規則ではない＝非日付文字列の手入力は拒否しない）。
  - **開き方** `openOn:'dblclick'`（既定）=ダブルクリック/F2/Enter/Alt+↓/セル右端の 📅 アイコン、`'icon'`=📅/Alt+↓ のみ。
    表示中は ←→↑↓（日）・PageUp/Down（月）・Enter 確定・Esc/Tab 取消・「今日」「クリア」（blank）。
  - 確定は既存 chokepoint（`submitSetCells`）へ流す＝Undo・cell-commit・OCC（開いた時点で beforeRevision 凍結）が既存経路で成立。
    editor-state-machine・ime-editing-session は無改変（カレンダーは listbox と同方式の別 DOM・focus は textarea のまま）。
  - `readOnly`／`readOnlyColumns` の列では開かない。`openOn` 不正値は `column-types-invalid` で fail-fast。
- **grid 読み取り専用列 `readOnlyColumns`（Experimental・DD-035 R4）**: ColumnId 配列で指定した列のセルを編集不可にする
  （列タイプと直交・両モード共通・mount 時固定）。
  - **抑止（入口）**: 編集開始（印字キー・F2・ダブルクリック・IME）／Delete・Backspace／選択式ドロップダウン／日付カレンダー。
    アクティブセルが指定列にある間、常駐 textarea は `readOnly` 属性（実 IME 物理遮断）＋編集 DOM イベントの dispatch 抑止。
  - **範囲操作**: 貼り付け・範囲クリア・cut のクリアは指定列のセルだけ**スキップ**して他列へ適用（TSV 列位置不変・全件スキップは
    no-op・診断 `readonly-column-skipped`）。**保証層**: 指定列への変更を含む SetCells は submit 直前で op 全体を破棄
    （診断 `readonly-column-blocked`）。
  - 維持: 範囲選択・コピー・スクロール・リサイズ・link-open・行挿入削除・setData・リモート受信反映。**権限制御ではない**
    （サーバー側強制なし）。未知列・重複は `column-types-invalid` で fail-fast。新規公開 error/conflict code なし。
- **grid 命令 API `scrollToRow(rowId)` / `setActiveCell(rowId, columnId)`（Experimental・DD-035 R6）**: 指定行の可視化
  （最小スクロール・横不変）とアクティブセル移動（クリック同経路＝編集中は確定して移動・ポップアップを閉じ・textarea へ focus）。
  `setData`／`insertRows` の**直後**でも同期で成立する（行 Axis 未再構築ならその場で再構築してから適用・初回描画前のみ保留）。未知 ID は診断 warn
  （`scroll-row-unknown`／`active-cell-unknown`）のみで no-op。
- **react `NanairoSheetViewHandle` の命令 API 4 点＋列スキーマ props 6 点（Experimental・DD-035 R7）**: handle へ
  `insertRows`／`deleteRows`／`scrollToRow`／`setActiveCell`（GridInstance 直結・未 mount は `handle-before-mount` warn）を追加。
  props へ `columnTypes`／`columnFormats`／`columnCaptions`／`columnDisplayFormats`／`readOnly`／`readOnlyColumns`
  （grid 同名オプションへ 1:1 写像・識別系＝値変更で自動 remount）を追加した（DD-027/033 の列スキーマ系が React Facade から
  到達不能だったギャップの解消）。
- **grid 表示専用モード `readOnly`（Experimental・DD-033-1）**: mount オプション1点（両モード共通・mount 時固定）で
  文書を一切変更できない閲覧専用グリッドを提供する（明細閲覧ビュー DD-033 の第1子）。
  - **2層抑止**: 入口（編集開始〔キー入力・F2・ダブルクリック・IME〕・paste/cut・Delete/Backspace クリア・
    行挿入削除〔ショートカット・公開 API `insertRows`/`deleteRows`〕・Undo/Redo・選択式ドロップダウン）＋
    chokepoint（SetCells 系 submit の単一防衛線）で文書 Operation 送信ゼロを保証する。
  - **閲覧系は維持**: 範囲選択・コピー（TSV は従来と同一）・スクロール・列幅行高リサイズ・auto-fit・link-open・
    presence 送信。`setData` は許可（閲覧データの差し替え手段）。
  - 共同編集モードでは**受信反映のみ**。**権限制御ではない**（サーバー側強制なし・アクセス制御は利用側責務）。
  - 診断: 抑止時 `readonly-blocked` info・mount 時 `readonly-mode` info・非 boolean 指定は `readonly-invalid` warn
    （新規公開 error code・新規イベントなし）。
- **grid 列見出しキャプション・数値/日付表示書式（Experimental・DD-033-2）**: `columnCaptions`
  （ヘッダー A/B/C を業務名へ置換描画・自ヘッダーセル幅で fitText クリップ）と `columnDisplayFormats`
  （number=`{ grouping?, decimals?, percent?, prefix?, suffix? }`・date=`YYYY`/`MM`/`DD`/`HH`/`mm`/`ss` トークンの
  パターン文字列）を追加した（明細閲覧ビュー DD-033 の第2子。両モード共通・mount 時固定）。
  - **Canvas 描画テキストのみ**を整形する view-local 機能: コピー TSV・cell-commit・setData round-trip・編集ドラフト・
    `columnFormats` の match はすべて raw のまま＝**表示文字列契約は不変**。
  - number は数値形 raw のみに適用し**文字列ベース十進整形**（half-up・2進誤差なし）。date は ISO 2形
    （`YYYY-MM-DD`／`YYYY-MM-DD[T|空白]HH:mm(:ss)`）のみ受理（タイムゾーン非経由）。非該当 raw は素通し。
  - 併用: `wrapColumns` 同一列・リンク列は fail-fast。選択式列は許可（候補・検証は raw のまま）。auto-fit は
    書式済みテキスト幅＋キャプション幅で列幅を決める（描画と測定の一致）。
  - **fail-fast 追加**: 新公開 error code **`column-display-invalid`**（phase=`config`。未知列・空キャプション・
    `decimals` 範囲外・不正 pattern・wrap/link 併用）。共同編集モードでの全クライアント設定一致は利用側責務。
  - Excel 書式文字列互換・Intl ロケール書式・数値シリアル日付・2段ヘッダーは v1 対象外（拡張点メモ）。
- **grid セル書式モデル（背景色・バッジ・auto-fit・Experimental・DD-027-3）**: 利用側供給の「値→書式マッピング」による
  **view-local** なセル書式描画を追加した（親④・列タイプ体系 DD-027 の第3子）。
  - **公開型 `GridColumnFormatRule` / `GridCellFormatStyle`（`columnFormats` の値・export）**: ルールは
    `{ match: string | string[], style: { cellBackground?, textColor?, badge?, badgeColor? } }`。`match` はセル
    **表示文字列の完全一致**（v1。範囲/正規表現/callback・静的列色は対象外＝P-07 拡張点メモ）。core の値モデル
    （CellScalar）・protocol・snapshot は無変更（文書状態は変えない＝view-local）。
  - **新 mount オプション `columnFormats`（両モード共通・mount 時固定）**: `Record<ColumnId, GridColumnFormatRule[]>`。
    mount 時に「列→値→style」Map へプリコンパイルし、描画ホットパス（可視非空セル×毎フレーム）は O(1) lookup にする。
    書式は **非空セルのみ**に付く（空セル・非一致値・未指定列は現行描画と完全一致）。
  - **描画**: 背景色はセル矩形から罫線幅ぶん inset して文字より先に塗る（罫線・選択枠を保存・1 pass 維持）。`badge:true` は
    値を丸角チップ（badgeColor 塗り＋textColor 文字・単行 fitText クリップ）で描き、**右隣へオーバーフローしない**
    （リンク列と同じ裁定）。`textColor` は数値既定色より優先（右寄せ等の配置は維持）。
  - **ダブルクリック auto-fit（C級）**: 列境界のダブルクリックで列幅を内容（列内の最長表示文字列＋ヘッダーラベル幅＋
    パディング・clamp 20〜2000px）へ合わせ、`layout` イベントを発火する（DD-012-4 D2 の利用側保存契約を維持）。
    **wrap 列は対象外**（診断 info・無変更）。走査は **10,000 非空セルで打ち切り**（それまでの最大値を採用・診断 info）。
  - **fail-fast 追加**: 不正 `columnFormats`（未知列・空ルール配列・空 match〔空配列/空文字〕・同一列内の match 重複）は
    mount 時に公開 `error`（phase=`config`・`code: 'column-types-invalid'`）で通知し配線しない（`columnTypes` と同経路）。新規 reject 語彙・
    新規イベントなし（auto-fit は既存 `layout`）。共同編集モードでの全クライアント設定一致は利用側責務（値は string のまま）。
  - **共有化（Operation 化・snapshot 拡張）は設計文書のみ**: `doc/plan/cell-format-sharing-design.md` に FormatOperation の
    形・snapshot/hash/OCC 拡張方針・発火条件と実装子DD採番手順を記載（実装は共同編集採用案件の確定で採番＝親④・発火条件付き）。
- **grid ハイパーリンク列（クリック→link-open・Experimental・DD-027-2）**: 列単位でセルクリックを「詳細画面への遷移材料」として
  利用側へ通知するハイパーリンク列を追加した（親③・列タイプ体系 DD-027 の第2子）。
  - **公開型 `GridLinkColumnType { type: 'link'; defaultOpen?: boolean }`（`columnTypes` の値・`GridColumnType` union へ追加・export）**:
    値は string 1本（表示テキスト＝URL または任意テキスト）。core の値モデル（CellScalar）・protocol・snapshot は無変更。
  - **新イベント `link-open`（両モード共通）**: `{ type: 'link-open'; rowId: string; columnId: string; value: string }`。リンク列の
    非空セルをクリック（押下→同一セルで離す・単クリック）すると発火する。**SDK は navigate しない**（利用側が rowId/columnId/value を
    受けて SPA 内遷移や詳細表示を実装する＝責務境界）。クリック時の activeCell 移動は従来どおり並行して起こる（選択を奪わない）。
  - **発火しないクリック（既存 UX を保存）**: セルをまたぐドラッグ（レンジ選択）・Shift+クリック（レンジ拡張）・空セル・
    編集/変換（IME）中のクリック・キーボード/タッチ（対象外）では発火しない。dblclick 編集の 1 打目でのみ 1 回発火する
    （2 打目では発火しない）。既存の pointerdown/選択/編集/IME 裁定は無改変（候補追跡方式の上乗せ＝T1 非該当）。
  - **`defaultOpen:true`（opt-in・既定 false）**: `link-open` に加えて SDK が **絶対 http/https URL のみ**
    `window.open(value, '_blank', 'noopener,noreferrer')` で開く。`javascript:`/`data:`/相対/非 URL は open せず診断 warn
    （`link-open` イベント自体は defaultOpen の成否に関わらず常に発火）。
  - **描画**: リンク列の非空セルはリンク色（#1a73e8 系）＋下線・**自セル内 fitText クリップ**で描く（右隣へオーバーフローしない
    ＝クリック領域と描画を一致）。数値に解釈される値もリンク列ではリンク描画を優先する（表示文字列は不変）。hover で cursor:pointer。
  - **fail-fast 追加**: リンク列と `wrapColumns`（折り返し）の併用は描画契約が両立しないため mount 時に公開 `error`
    （phase=`config`・`code: 'column-types-invalid'`）で通知し配線しない（`column-types-invalid` の対象事由に「リンク×wrap 併用」を追加）。
  - 新規 reject 語彙なし（defaultOpen の不正 URL は診断 warn のみ）。共同編集モードでの全クライアント設定一致は利用側責務（値は string のまま）。
- **grid 選択式入力列（列タイプメタ・Experimental・DD-027-1）**: 列単位で「決められた値だけ選択入力できる」選択式列を追加した。
  - **公開 mount オプション `columnTypes`（両モード共通・mount 時固定・`wrapColumns` と同運用）**:
    `Readonly<Record<string, GridColumnType>>`（ColumnId 文字列→列タイプ）。現状は選択式のみ＝
    `GridSelectColumnType { type: 'select'; options: readonly string[]; allowFreeText?: boolean }`。`GridColumnType`/`GridSelectColumnType`
    を公開型として export した。列タイプは **grid 層のメタ**で、core の値モデル（CellScalar）・protocol・snapshot は無変更（値は string のまま）。
  - **編集 UX**: 選択式列（`allowFreeText:false`・既定）のセルで dblclick / F2 / Enter / Alt+↓ / 印字文字 → 常駐 textarea 編集ではなく
    候補ドロップダウン（listbox・現値ハイライト）が開く。↑↓ + Enter または候補クリックで確定し、既存 chokepoint 経由で SetCells 1 件を
    確定する（共同編集=他クライアント反映・単独モード=`cell-commit` 発火・Undo で戻せる）。Esc / 外クリックで取消（文書無変更・focus は
    常駐 textarea のまま）。アクティブセルが選択式列のとき ▼ インジケーターを表示する。IME 経路（editor-state-machine・常駐 textarea・
    composition）は**無改変**（横取りは mount-controller の既設 hook のみ・composition 中は必ず非消費）。
  - **検証は editor 経路（IME/textarea 確定・ドロップダウン）の commit 直前だけ**: `allowFreeText:false` の選択式列へ候補外の値を editor 経路で
    確定すると **未 submit**（文書無変更）＋公開 `rejected`（`code: 'value-not-allowed'`・`operationId` 空文字）＋診断（拒否値を含む・単独モードは
    診断のみ）で通知する（サイレント失敗なし）。`allowFreeText:true` の列は候補外も従来どおり確定できる。
  - **paste / setData / リモート由来の非候補値は検証されず保持・表示される**（拒否しない＝データ非破壊・収束優先）。
  - **fail-fast**: 不正な `columnTypes`（未知列・候補 0 件・重複候補・未対応 type）は mount 時に公開 `error`（phase=`config`・
    `code: 'column-types-invalid'`）で通知し配線しない。
  - registry（ColumnTypeRegistry）は **Internal**（consumer 向けの登録 API は公開しない）。共同編集モードでの全クライアント設定一致は
    利用側責務（値は string のままゆえ文書 hash・収束は乖離しない）。動的候補供給（callback/Promise）は拡張点メモのみ（P-07 材料・未実装）。
  - **公開語彙追加**: `GRID_ERROR_CODES` に `column-types-invalid`、`GRID_CONFLICT_CODES` に `value-not-allowed`（一覧は error-codes.md）。
- **server-hono consumer 統合の 3 つの口（Experimental・DD-026・DD-026-1〜3）**: 共同編集サーバーを利用側の DB と認証につなぐ公開 API を追加した
  （公開型は `Serve*`・内部 package の型を露出しない。quick-start §3b）。
  - **U1 永続化ストアの差し替え（DD-026-1）**: `serve({ oplog, snapshotStore })` に利用側実装（例: Postgres）を渡せる（両方同時指定が必須・
    `persistenceDir` とは併用不可）。`append` 解決＝durable の契約はファイル永続化と同じ。**`initialDocument`**（snapshot も操作ログも無い
    ときだけ呼ばれ、結果が document@0＝revision 0。ストア指定時は snapshot@0 を保存してから listen。`seedRows` とは併用不可）。
    - 付随変更: **persisted snapshot format v2**（checksum を深いキー順ソートで正準化＝jsonb 等キー順を保持しない保存先でも検証可能。
      v1 ファイルは旧算法で読める＝既存 `persistenceDir` はそのまま使える）／**非空 document@0 への fresh join は bootstrap@0 を送る**
      （空文書@0 は従来どおり送らない。クライアントは committed 0 かつ未 bootstrap のときだけ受理）。
  - **U2 認証フック（DD-026-2）**: `serve({ authenticate })`。WebSocket upgrade 時に `{ url, headers }` を受けて `{ actorId, displayName } | null`
    を返す。null は 401・throw は 500 で接続拒否。受理後は envelope の `actorId`・presence の `userId`/`displayName` をサーバーが上書きする
    （申告は無視。`clientId` は申告維持）。診断コード `auth-rejected`（warn）/`auth-error`（error）を追加。未指定なら従来どおり。
  - **U3 サーバー起点操作（DD-026-3）**: `ServerInstance.submit(setCells, { actorId })`。通常の受理経路（revision 付与・全接続へ配信・永続化）を
    通り、`clientId: 'server'`（予約語）で記録される。reject（OCC 等）は結果（`status: 'rejected'`・`code`）で返し、durable 失敗・stop 後は
    Promise reject。利用者の Undo 対象にならない。
  - 公開 .d.ts snapshot 更新済み（追加のみ・破壊的変更なし・migration guide 不要）。
- **grid 行操作の収束・UI 状態整合・性能（Experimental・DD-021-2/DD-021-3）**: 行 Insert/Delete を共同編集で安全にする層を追加した。
  - **収束保証（DD-021-2）**: 同一アンカーへの同時 Insert はサーバー受付順で**両方の行を保持**して全クライアント収束（意図順は非保証・reject しない）。
    削除済み行への SetCells は既存 `rejected`（`row-unavailable`/`cell-conflict` 系）経路で通知（サイレント上書きなし）。再 Delete は冪等。
    reconnect（offline 中の行操作を含む）後も catch-up で収束・二重適用なし。protocol・server・IME 状態機械は無変更。
  - **K4=IME 編集中の対象行削除（DD-021-2・挙動変更）**: 従来（Alpha/DD-005）は削除受信で**編集を即時中断しドラフトを内部退避**していたが、
    **編集継続**（draft/textarea/composition 非破壊・行消失インジケーター表示）へ変更した。退避は利用者が**確定（commit）した時点**で行い、
    公開 `rejected` イベント（`code: 'row-unavailable'`・`operationId` 空文字）＋診断 `draft-diverted` で通知する（単独モードは診断のみ）。
  - **K3=選択・activeCell の再ベース（DD-021-3）**: リモート/ローカルの行 Insert/Delete 後、activeCell・選択レンジ（ドラッグ中含む）・
    Enter/Tab 移動先が**行実体（RowId）を追従**する（削除行は最近傍生存行〔下優先→上〕へ縮退・生存行皆無で選択解除）。編集/変換中は
    editingTarget が追従（I-3 維持）。
  - **P2-1 性能是正（DD-021-3）**: 単一行 Insert 連発の Θ(N²)（slot 採番の全走査）を O(1) 採番へ是正。実測: 50,000 行文書＋Insert×1,000=
    合計 128ms（目標 2s）・per-op p95 0.186ms（目標 5ms）・bulk 10,000 行 2.6ms・replay 決定性維持。回帰ガードを CI 常設。
  - Undo との整合: 削除行に触れる Undo/Redo エントリは実行前に生存検査で拒否・スタックから除去＋既存 `undo-blocked`/`redo-blocked` 通知
    （行操作自体の Undo は対象外＝計画書 §15.3 MVP後）。
- **grid 行操作 公開 API（Experimental・DD-021-1）**: 行 Insert/Delete を利用者機能として公開した。
  - **公開 API**: `GridInstance.insertRows({ afterRowId: string | null; count?: number })`（`afterRowId` 直後へ `count` 行〔既定 1〕挿入・
    `afterRowId=null` で先頭）／`GridInstance.deleteRows(rowIds: readonly string[])`（実在行のみ tombstone 化・重複/非現存は無視）。
    いずれも**同期 throw しない**（既存 API 流儀）。新 RowId は `crypto.randomUUID` で採番する。
  - **新イベント `row-structure-change`（両モード共通）**: `{ type: 'row-structure-change'; change: GridRowStructureChange }`。
    `GridRowStructureChange = { kind: 'insert'; afterRowId: string | null; rowIds: readonly string[] } | { kind: 'delete'; rowIds: readonly string[] }`。
    ローカル行操作の楽観適用時に発火する。**単独グリッドモードではこれが行構造の保存材料**（`cell-commit` はセル値専用のまま）。
    共同編集モードでも発火するが行構造の永続化はサーバー責務（通知のみ・grid は書き戻さない）。他クライアント起因の通知・選択再ベースは後続（DD-021-2/3）。
  - **Excel 準拠ショートカット**: `Ctrl+Shift+'+'`=アクティブ行の**上**へ 1 行挿入・`Ctrl+'-'`=選択範囲（無選択時は activeCell）の行削除。
    **Navigation 位相かつ非 composing のときだけ**グリッド化し、Editing/Composing 中はブラウザ既定へ委譲する（IME 非干渉・I-3・状態機械へ遷移追加なし）。
  - **削除時の activeCell 縮退**: 自分の削除でアクティブ行が消えたら最近傍生存行（下優先→上）へ移動・選択は生存行へ縮退（生存行皆無なら選択解除）。
  - **公開語彙追加**: `GRID_CONFLICT_CODES` に `'row-anchor-unknown'`（insert の未知アンカー）・`'row-count-invalid'`（count が **1〜100,000**
    の整数でない＝上限は SetCells セル数上限と同値の実行前ガード）・`'row-delete-empty'`（delete 対象が空/全て非現存）を追加（いずれも
    submit 前拒否＝`GridConflict.operationId` は空文字・共同編集モードのみ `rejected` 発火／単独モードは診断のみ）。既存コードの意味変更なし
    （union 追加のみ）。公開 .d.ts snapshot 更新済み（破壊的変更なし）。
  - **境界**: boot 未完了時は黙って無視（`setData` と異なり保留適用しない）。接続終端（`connectionState()==='stopped'`）後は no-op（診断のみ・
    同期 throw しない）。
- **grid Undo/Redo（Experimental・DD-020-3）**: 確定単位（1 利用者操作＝1 SetCells＝セル確定/貼り付け/cut/範囲クリア）の Undo/Redo を
  **クライアント主導・補償 SetCells**（ADR-0024・protocol 変更なし）で提供した。単独・共同の両モードで同一機構（`submitLocalOperation` 経由）。
  - **キーバインド**: `Ctrl/Cmd+Z`=Undo・`Ctrl+Y`/`Ctrl+Shift+Z`/`Cmd+Shift+Z`=Redo。**Navigation 位相かつ非 composing のときだけ**グリッド
    Undo/Redo 化し、Editing/Composing 中はブラウザ既定（textarea 内テキスト undo）へ委譲する（IME 非干渉・I-3）。
  - **スタック仕様**: 深さ 100（超過は古い順に破棄）・**自分の操作のみ**・セッション内（reload で消える・永続化しない）・pending 中は ACK まで Undo 不可・
    新規通常操作で Redo スタック破棄。
  - **競合時（R-07 対策）**: 補償 SetCells は「自分の最後の確定 revision」を beforeRevision に使い、他者が対象セルを後続変更していれば OCC
    （`stale-cell-revision`）で**全体 reject**（強制 Undo せずサイレント上書きを防ぐ）。単独モードでは OCC 競合が起きないため常に成立する。
  - **公開語彙追加**: `GRID_CONFLICT_CODES` に `'undo-blocked'`（Undo の補償 op が OCC で全体 reject）・`'redo-blocked'`（Redo の補償 op が
    OCC で全体 reject）を追加（いずれも `GridConflict.operationId` は補償 op の ID）。既存コードの意味変更なし（union 追加のみ）。公開 .d.ts snapshot 更新済み。
  - 単独モードの Undo/Redo は cell-commit（SetCells batch 単位）を発火し利用側保存契約（DD-024）と整合する。
- **grid clipboard copy/cut/paste（Experimental・DD-020-2）**: 常駐 textarea の ClipboardEvent を主経路に、Navigation 位相の
  copy/cut/paste をグリッド Command として提供した（Editing/Composing 位相はブラウザ既定＝textarea 内テキスト編集・IME 非干渉）。
  - **copy**: 選択範囲（未選択時は activeCell 単一）の表示文字列を TSV（text/plain）で書き出す（タブ/改行/`"` を含むセルのみ引用）。
  - **cut（親④）**: copy＋即時範囲クリア（1 原子 SetCells・移動セマンティクスにしない）。クリアが上限超過なら cut 全体を拒否。
  - **paste**: text/plain を TSV 解析し、**matrix 1×1 かつ複数セル選択なら選択範囲全体へ敷き詰め**／それ以外は選択左上
    アンカーから matrix サイズで貼り付ける。各セルは `parseCellInput` で number/date/string へ変換し、セル単位 beforeRevision 付きの
    **1 原子 SetCells**（全成功/全失敗＝OCC）で適用する。列数不整合 TSV の欠けセルは変更対象に含めない（skip）。
  - **公開語彙追加**: `GRID_CONFLICT_CODES` に `'paste-too-large'`（貼り付けセル数が上限 100,000 超過→実行前拒否）・
    `'paste-out-of-bounds'`（貼り付け矩形が行/列端を越える→全体拒否＝切り捨てない）を追加（いずれも submit 前拒否＝
    `GridConflict.operationId` は空文字）。既存コードの意味変更なし（union 追加のみ）。公開 .d.ts snapshot 更新済み。
  - TSV parser/serializer は `@nanairo-sheet/core`（`parseClipboardText`/`serializeMatrix`・純関数・依存ゼロ）。
- **grid 矩形範囲選択・範囲クリア（Experimental・DD-020-1）**: ドラッグ／Shift+クリック／Shift+矢印による矩形範囲選択と、
  範囲 Delete（範囲内の非空セルを 1 つの原子的 SetCells で blank 化・セル単位 beforeRevision 付き＝OCC で全成功/全失敗）を追加した。
  - 上限: 範囲セル数が **100,000** を超える範囲クリアは実行前拒否し、`rejected` イベント（下記 `range-too-large`）で通知する
    （選択は維持され縮めて再実行できる）。範囲クリアの Undo は DD-020-3 まで提供されない（既知制約）。
  - **公開語彙追加**: `GRID_CONFLICT_CODES` に `'range-too-large'` を追加（クライアントが submit 前に拒否する実行前検査。
    `GridConflict.operationId` は空文字＝未 submit）。既存コードの意味変更なし（union 追加のみ・未知コードは従来どおり
    `'unknown'` フォールバック契約）。公開 .d.ts snapshot 更新済み（破壊的変更なし）。
  - IME 不変（I-3/CG-1）維持: 選択操作・範囲 Delete は editor-state-machine の前段（純関数裁定）で消費し、
    composition 中・編集中は一切消費しない（状態機械・textarea の value/selection/DOM 親は無変更）。
- **grid Excel風テキスト表示（Experimental・DD-012-5）**: セル文字の Excel 風表示を追加した。
  - **オーバーフロー（描画のみ・データ不変）**: 左寄せ描画の文字列セルは、右隣の連続空セルへはみ出して全文表示される。
    右隣に非空セルが来る手前・pane（固定行列）境界・viewport clip で止まり、収まらなければ末尾を `…` で省略する。数値（右寄せ）は対象外。
    可視範囲の左外にあるはみ出し元も、行ごとに最大 **20 列**遡って描画する（性能予算優先の境界）。
  - **折り返し＋自動行高**: `GridMountOptions.wrapColumns?: readonly string[]`（ColumnId 文字列の配列）を追加。指定列のセルは
    はみ出さずセル内で**文字単位**（CJK 前提）に折り返し、折り返しで収まらない行は必要な高さへ**自動拡張**される（値の短縮・削除で自動縮小）。
    **手動リサイズ済みの行は手動値を優先**（Excel 同様）。自動行高は環境・フォントで再現される導出値のため **`layout` イベントには含めない**
    （利用側が保存するのは手動 override のみ）。wrap 列指定は mount 時固定（実行時切替は Stage 2）。
  - IME 不変（I-3）維持: 自動行高の変化でも textarea の value/selection/DOM 親には触れず、配置（place）のみを更新する。
- **grid 列幅・行高リサイズ（Experimental・DD-012-4）**: 列ヘッダー右端／行ヘッダー下端の境界ドラッグで列幅・行高を変更できる
  （±4px の掴み代・`col-resize`/`row-resize` カーソル・最小 列20px/行16px・最大 2000px でクランプ）。設定は **view-local**
  （他ユーザーへ即時同期しない）。
  - `GridMountOptions.columnWidths?: Readonly<Record<string, number>>`（ColumnId 文字列→px・初期 override）を追加。
  - `GridMountOptions.rowHeights?: Readonly<Record<string, number>>`（RowId 文字列→px・初期 override）を追加。
  - `GridEvent` に `{ type: 'layout'; columnWidths: Record<string, number>; rowHeights: Record<string, number> }` を追加。
    境界ドラッグ確定時（pointerup）に発火し、**既定値と異なる列/行だけ**（override のみ）を含む。利用側はこれを保存し、次回 mount の
    `columnWidths`/`rowHeights` へ渡すと F5 リロードで復元できる（保存先を共有にすれば他ユーザーへも反映）。
  - IME 不変（I-3）維持: リサイズの pointer 操作は編集状態機械へ流さず、変換中でも textarea の value/selection/DOM 親に触れない。

### Fixed

- **他ユーザーの Presence 枠・名前タグが固定ペインへはみ出す不具合（DD-041）**: `frozenColumnCount ≥ 1` /
  `frozenRowCount ≥ 1` で、**他ユーザーの activeCell が固定帯の裏へ回った位置にあると、その枠と名前タグが
  固定行・固定列の上へ重なって描かれていた**。枠とタグだけが「ヘッダーを除いた全セル領域」の単一 clip で
  描かれており、固定帯の裏のセル矩形がそのまま固定ペインの内側に落ちていた。選択範囲ハイライトと同じく
  pane ごとの clip で描くよう修正した（DD-039 と同根・別箇所）。
  - **表示のみの不具合**で、値・編集・計算には影響していなかった。Presence の**選択範囲ハイライトは元から正しく**、
    自分の選択枠・ドラッグ枠も pane 分割済みで無変更。
  - **名前タグは pane 境界で欠ける**（枠と同じ clip に入るため）。viewport 上端では従来から同じ欠け方をしており、
    固定境界でも見え方が一貫する。
  - **公開 API の追加・変更はない**（`.d.ts` snapshot 差分なし）。`frozenRowCount` / `frozenColumnCount` が
    0 のときの描画は従来と完全に同一（clip 矩形・描画座標とも一致）。

- **固定ペインのヘッダーにスクロール側の見出しが重なる不具合（DD-039）**: `frozenColumnCount ≥ 1` で横スクロールすると、
  固定帯の裏へ回ったスクロール列の**列見出しが固定列の見出しの上へ描かれ**、固定列のラベルが読めなくなっていた。
  `frozenRowCount ≥ 1` の縦スクロールでも行番号帯で同じことが起きていた（**固定行の既定値 1 のまま**の consumer で発生）。
  ヘッダー帯をセル本体と同じく pane 境界で clip するよう修正した（固定境界をまたぐ見出しは境界で切れる）。
  - **表示のみの不具合**で、値・編集・計算・ヒットテストには影響していなかった（セル本体は pane ごとに clip 済み）。
  - **公開 API の追加・変更はない**（`.d.ts` snapshot 差分なし）。`frozenRowCount` / `frozenColumnCount` が
    0 のときの描画は従来と同一（入れ子の clip を張らない）。

### Changed（破壊的変更・Experimental 0.x）

- **grid 貼り付け後に選択レンジとアクティブセルが動くようになった（DD-038）**: 従来の貼り付けは文書を書き換える
  だけで選択に触れなかったが、成立した貼り付けの後は**貼付範囲が選択され、アクティブセルが矩形の左上へ移る**。
  - **公開 API の追加・変更はない**（`.d.ts` snapshot 差分なし）。設定で無効化する手段も設けていないため、
    tarball を更新すると自動的に新挙動になる。
  - **影響**: 貼り付け直後のアクティブセル位置を前提にしたキーボード操作（貼り付け → 矢印キーで移動、など）の
    起点が変わりうる。文書状態・protocol・snapshot・cell-commit イベント・コピー TSV は**一切変わらない**
    （選択という view-local な状態だけの変更）。
  - **拒否・noop・読み取り専用による全件スキップでは従来どおり選択は動かない**（文書無変更なら選択も無変更）。

- **grid `columnTypes` の `allowFreeText: true` で候補ドロップダウンが出るようになった（DD-037）**: 従来は
  `allowFreeText: true` の選択式列で候補 UI が**一切出ず**（ドロップダウン・▼ インジケーターとも）、実質プレーン
  テキスト列と同じだった。DD-037 で「候補 UI を出すか」と「候補外の commit を許すか」を分離した結果、
  `allowFreeText: true` でも候補 UI が出る。
  - **公開 `.d.ts` の記載範囲では契約変更ではない**（`allowFreeText` の doc comment は候補外 commit の可否だけを
    約束しており、候補 UI の表示可否には言及していなかった）。ただし**実挙動が変わる**ため破壊的変更として記録する。
  - **影響**: `allowFreeText: true` を「候補を隠す」目的で使っていた consumer は、ダブルクリック／F2／Enter／Alt+↓ で
    候補が開き、編集中に前方一致の候補リストが出るようになる。**commit の可否・文書状態・protocol・snapshot・
    コピー TSV は一切変わらない**（表示と編集 UI だけの変更）。
  - **`allowFreeText: false`（既定）の挙動は完全に不変**（候補のみモード＝候補外は `value-not-allowed` で拒否）。
  - 現時点で「候補を出さない選択式列」の設定は提供しない（要求が出たら registry の `showsSuggestions` だけが分岐する）。

## [0.1.0-alpha.0] — 2026-07-14（DD-017）

初回の Alpha 配布版。配布 closure = `@nanairo-sheet/{grid,server-hono,core,types,collab,render,selection,ime,server}`（9 package）。
`formula` は Alpha 配布 closure 外（現行 Facade の実行時依存でないため未配布・版据え置き）。

### Added

- **配布**: pack tarball closure 方式の正式化（決定事項A）。`scripts/release/build-release.sh`（再現 build ゲート＝typecheck/lint/test →
  9 tarball → manifest〔版数・sha256・生成コミット・channel=alpha〕）。`scripts/consumer-app.sh` は `RELEASE_VENDOR_DIR` で配布成果物経由の
  スモークに対応。
- **版採番**: 配布 closure 9 package を `0.1.0-alpha.0` へ採番（従来 `0.0.0`）。
- **診断（grid）**: `GridEvent` の `error` / `rejected` に**安定した公開エラーコード**を付与（`GRID_ERROR_CODES` / `GRID_CONFLICT_CODES`）。
  内部 `RejectCode` を素通しせず公開語彙へ写像（R7）。未知コードは `unknown` フォールバック。一覧は `doc/DD/DD-017/error-codes.md`。
- **診断（grid）**: `GridMountOptions.onDiagnostic`（debug logging hook・opt-in・既定無出力）を追加。`GridDiagnostic` / `GridDiagnosticLevel` /
  `GridDiagnosticHook` を公開。
- **診断（server-hono）**: `ServeOptions.onDiagnostic`（opt-in・既定無出力・`serve-started`/`serve-stopped`）を追加。`ServeDiagnostic` /
  `ServeDiagnosticLevel` / `ServeDiagnosticHook` を公開。
- **文書**: `doc/quick-start.md`（consumer 向け Quick Start）・`CHANGELOG.md`（本ファイル）を新設。

### Changed（破壊的変更・Experimental 0.x）

- **grid `GridEvent` error**: `code: GridErrorCode` を**必須追加**（`config-unavailable` / `config-invalid` / `connect-failed` / `runtime-fault`）。
  既存の `phase` / `message` は不変。error を読むだけの consumer は影響なし（フィールド追加）。
- **grid `GridConflict.code`**: 型を `string`（内部 `RejectCode` 素通し）から公開語彙 `GridConflictCode` へ変更し、**任意（`code?`）から必須（`code`）へ**。
  値は写像後の安定コード（例 `stale-cell-revision` → `cell-conflict`）。生の内部コードに依存していた consumer は写像表（`error-codes.md`）で追随する。

### Notes

- **Tier 1 対応環境**: Windows Chrome / Edge のみ（ADR-0015 D2・CG-4）。他 OS / ブラウザは対象外（明示・非検証）。
- **配布形態**: TS ソース配布を継続（`main: ./src/index.ts`）。consumer は TS を透過コンパイルできるビルド環境（vite 等）が前提。dist ビルド配布は Stage 2。
- **registry 昇格**: private registry publish は Stage 2/子DD（package.json に `publishConfig` を足し `npm publish --tag alpha` へ切替可能な形で据え置き）。
