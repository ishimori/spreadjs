// @nanairo-sheet/react — React Facade（Experimental 0.x・DD-025）。
//
// <NanairoSheetView> は grid Facade（@nanairo-sheet/grid）の **薄い写像** に徹する（憲章 §11.2）:
//   - lifecycle: effect で mount() → cleanup で destroy()。StrictMode の二重 mount/cleanup に耐える。
//   - props 写像: GridMountOptions（判別 union）を判別 union props へ 1:1（契約 §1）。
//   - event 写像: GridEvent を options.onEvent 1 本で受け、個別 callback props へ分配（契約 §2）。
//   - 命令 API: ref handle（setData/focus/connectionState のみ・契約 §3）。GridInstance 本体は出さない。
// **グリッド内部状態（文書データ）を React state へ複製しない**。再注入は ref.setData（effect から流す）。
//
// 【R7】公開シグネチャに grid の公開型を参照するが、grid シンボルの再エクスポートはしない（boundary lint）。
// 【配布・契約 §7】JSX 構文糖を使わず createElement で container <div> を返す（.tsx 配布を避け .ts に留める）。

import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ForwardedRef,
} from 'react';
import {
  mount,
  type GridCellCommitChange,
  type GridColumnDisplayFormat,
  type GridColumnFormatRule,
  type GridRowBorders,
  type GridColumnBorders,
  type GridColumnType,
  type GridConnectionState,
  type GridDiagnosticHook,
  type GridErrorCode,
  type GridEvent,
  type GridInstance,
  type GridMountOptions,
  type GridStandaloneData,
} from '@nanairo-sheet/grid';

/** 公開 API バージョン（Experimental 0.x・ADR-0015。grid の GRID_API_VERSION と対で版数表記する）。 */
export const REACT_API_VERSION = '0.1.0-experimental' as const;

/** error callback へ渡す整形済みエラー（GridEvent 'error' の写像・R7: 内部型を出さない）。 */
export interface NanairoSheetViewError {
  readonly phase: 'config' | 'connect' | 'runtime';
  readonly code: GridErrorCode;
  readonly message: string;
}

/** 両モード共通 props（初期値系＋識別系の一部＋callback 系＋DOM ホスト）。 */
export interface NanairoSheetViewCommonProps {
  // --- 初期値系（初回 mount のみ有効・変更は無視＋診断 warn・契約 §4 分類2） ---
  /** 初期の列幅 override（grid columnWidths へ写像。初回 mount のみ）。 */
  readonly initialColumnWidths?: Readonly<Record<string, number>>;
  /** 初期の行高 override（grid rowHeights へ写像。初回 mount のみ）。 */
  readonly initialRowHeights?: Readonly<Record<string, number>>;
  // --- 識別系（mount 固定・変更で自動 remount・契約 §4 分類1） ---
  /** 折り返し列（grid wrapColumns。mount 固定＝変更で remount）。 */
  readonly wrapColumns?: readonly string[];
  /** ドキュメント ID（識別系）。 */
  readonly documentId?: string;
  // --- 列スキーマ系（DD-035・grid の同名 mount オプションへ 1:1 写像。mount 固定＝変更で remount・値で直列化） ---
  /** 列タイプ（grid columnTypes・DD-027-1/2＋DD-035 date）。選択式／リンク／日付カレンダー。 */
  readonly columnTypes?: Readonly<Record<string, GridColumnType>>;
  /** セル書式ルール（grid columnFormats・DD-027-3）。値→背景色・文字色・バッジ。 */
  readonly columnFormats?: Readonly<Record<string, readonly GridColumnFormatRule[]>>;
  /** 列見出しキャプション（grid columnCaptions・DD-033-2）。 */
  readonly columnCaptions?: Readonly<Record<string, string>>;
  /** 数値/日付の表示書式（grid columnDisplayFormats・DD-033-2）。 */
  readonly columnDisplayFormats?: Readonly<Record<string, GridColumnDisplayFormat>>;
  /** 表示専用モード（grid readOnly・DD-033-1）。 */
  readonly readOnly?: boolean;
  /** 読み取り専用列（grid readOnlyColumns・DD-035 R4）。 */
  readonly readOnlyColumns?: readonly string[];
  /** 読み取り専用行（grid readOnlyRows・DD-036 C3）。未知 RowId は grid 側で診断 warn のみ。 */
  readonly readOnlyRows?: readonly string[];
  /** 固定行数（grid frozenRowCount・DD-036 C1・既定 1）。 */
  readonly frozenRowCount?: number;
  /** 固定列数（grid frozenColumnCount・DD-036 C1・既定 1）。 */
  readonly frozenColumnCount?: number;
  /** 列単位の静的背景色（grid columnBackgrounds・DD-036 C2）。 */
  readonly columnBackgrounds?: Readonly<Record<string, string>>;
  /** 行単位の静的背景色（grid rowBackgrounds・DD-045）。RowId → CSS color。 */
  readonly rowBackgrounds?: Readonly<Record<string, string>>;
  /** 行ID→上下の実線。grid rowBordersと同じmount時固定の表示設定。 */
  readonly rowBorders?: Readonly<Record<string, GridRowBorders>>;
  /** 列ID→左右の実線。grid columnBordersと同じ契約。 */
  readonly columnBorders?: Readonly<Record<string, GridColumnBorders>>;
  // --- callback 系（内部 ref 保持・差し替えで remount しない・契約 §4 分類3） ---
  /** セル確定通知（GridEvent 'cell-commit' の写像）。 */
  readonly onCellCommit?: (changes: readonly GridCellCommitChange[]) => void;
  /** レイアウト確定通知（GridEvent 'layout' の写像）。 */
  readonly onLayout?: (
    columnWidths: Record<string, number>,
    rowHeights: Record<string, number>,
  ) => void;
  /** 接続状態変化（GridEvent 'connection'/'pending' の写像・collaboration のみ発火）。 */
  readonly onConnectionChange?: (state: GridConnectionState, pendingCount: number) => void;
  /** エラー通知（GridEvent 'error' の写像）。 */
  readonly onError?: (error: NanairoSheetViewError) => void;
  /** 全 GridEvent の素通し（診断・将来種別・rejected/divergence 用）。 */
  readonly onEvent?: (event: GridEvent) => void;
  /** grid 診断 hook（opt-in・grid onDiagnostic へ直結）。 */
  readonly onDiagnostic?: GridDiagnosticHook;
  // --- DOM ホスト ---
  readonly className?: string;
  readonly style?: CSSProperties;
}

/** 単独グリッドモード props（DD-024 standalone）。serverUrl/displayName/clientId を宣言しない（型排他）。 */
export interface NanairoSheetViewStandaloneProps extends NanairoSheetViewCommonProps {
  readonly mode: 'standalone';
  /** 列順（必須・識別系）。 */
  readonly columnOrder: readonly string[];
  /** 初期データ（初回 mount のみ・再注入は ref.setData）。 */
  readonly initialData?: GridStandaloneData;
}

/** 共同編集モード props（mode 省略時は既定 collaboration・後方互換）。 */
export interface NanairoSheetViewCollaborationProps extends NanairoSheetViewCommonProps {
  readonly mode?: 'collaboration';
  /** 同期サーバー origin（必須・識別系）。 */
  readonly serverUrl: string;
  /** 列順（省略時は /config 取得・識別系）。 */
  readonly columnOrder?: readonly string[];
  /** Presence 表示名（識別系）。 */
  readonly displayName?: string;
  /** 再接続で不変のクライアント ID（識別系）。 */
  readonly clientId?: string;
}

/** <NanairoSheetView> props（mode 判別 union・契約 §1 案a）。 */
export type NanairoSheetViewProps =
  | NanairoSheetViewStandaloneProps
  | NanairoSheetViewCollaborationProps;

/** ref handle（命令 API・契約 §3 案a）。GridInstance 本体は出さない。 */
export interface NanairoSheetViewHandle {
  /** 単独グリッドモードの文書丸ごと再注入（grid GridInstance.setData 直結。collab は grid 側で no-op+warn）。 */
  setData(data: GridStandaloneData): void;
  /** グリッドへフォーカス（常駐 textarea）。 */
  focus(): void;
  /** 現在の接続状態（未 mount 時は 'stopped'）。 */
  connectionState(): GridConnectionState;
  // --- DD-035 R7/R6: 行操作・スクロール・アクティブセルの命令 API（GridInstance 直結・未 mount 時は warn して無視） ---
  /** 行挿入（grid GridInstance.insertRows 直結・DD-021-1）。共同編集モードでは通常の submit 経路に乗る。 */
  insertRows(options: { readonly afterRowId: string | null; readonly count?: number }): void;
  /** 行削除（grid GridInstance.deleteRows 直結・DD-021-1）。 */
  deleteRows(rowIds: readonly string[]): void;
  /** 指定行を可視域へ（grid GridInstance.scrollToRow 直結・DD-035 R6）。setData/insertRows 直後の新 RowId でも成立。 */
  scrollToRow(rowId: string): void;
  /** 指定列を可視域へ（grid GridInstance.scrollToColumn 直結・DD-036 C4）。縦スクロールは動かさない。 */
  scrollToColumn(columnId: string): void;
  /** アクティブセルを移して可視化＋focus（grid GridInstance.setActiveCell 直結・DD-035 R6）。 */
  setActiveCell(rowId: string, columnId: string): void;
}

/** callback 群だけを保持する内部型（最新参照を subscribe から呼ぶ・stale closure 回避）。 */
interface CallbackBag {
  onCellCommit?: NanairoSheetViewCommonProps['onCellCommit'];
  onLayout?: NanairoSheetViewCommonProps['onLayout'];
  onConnectionChange?: NanairoSheetViewCommonProps['onConnectionChange'];
  onError?: NanairoSheetViewCommonProps['onError'];
  onEvent?: NanairoSheetViewCommonProps['onEvent'];
}

/** React-Facade レベルの診断 warn（grid の診断とは別系統。onDiagnostic があれば流し、無ければ console.warn）。 */
function warnFacade(props: NanairoSheetViewProps, code: string, message: string): void {
  props.onDiagnostic?.({ level: 'warn', code, message, timestamp: nowMs() });
  // 常に console にも出す（onDiagnostic 未指定でも気付ける・開発時想定）。no-console は本 config で未有効。
  console.warn(`[NanairoSheetView] ${message}`);
}

/** epoch ms（診断 timestamp 用。テスト環境でも Date は利用可能）。 */
function nowMs(): number {
  return Date.now();
}

/**
 * 列スキーマ系 props の正準直列化（Codex P2）: Record のキー順に依存しない（`{a,b}` と `{b,a}` を同一視）よう
 * オブジェクトはキーをソートして直列化する。配列は順序を保つ（select の候補順・columnOrder は意味を持つ）。
 * `readOnlyColumns` は集合として扱うため呼び出し側でソート済みのコピーを渡す。
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 識別系 props（mount 固定）を安定文字列へ直列化する。配列は値で直列化＝毎 render 新規リテラルを吸収（契約 §4）。 */
function mountKeyOf(props: NanairoSheetViewProps): string {
  const isStandalone = props.mode === 'standalone';
  return JSON.stringify({
    mode: props.mode ?? 'collaboration',
    serverUrl: isStandalone ? null : props.serverUrl,
    columnOrder: props.columnOrder ?? null,
    wrapColumns: props.wrapColumns ?? null,
    documentId: props.documentId ?? null,
    displayName: isStandalone ? null : (props.displayName ?? null),
    clientId: isStandalone ? null : (props.clientId ?? null),
    // DD-035: 列スキーマ系は mount 固定（grid 側が mount 時に registry 化・fail-fast する）＝値で直列化して remount 判定。
    // 列数規模（数十列）の小さな設定オブジェクトのため毎 render の直列化コストは無視できる（initialData とは異なる）。
    // Record 系はキー順非依存で正準化（Codex P2）。readOnlyColumns は集合＝ソート。wrapColumns は従来どおり順序保持。
    columnTypes: props.columnTypes === undefined ? null : canonicalJson(props.columnTypes),
    columnFormats: props.columnFormats === undefined ? null : canonicalJson(props.columnFormats),
    columnCaptions: props.columnCaptions === undefined ? null : canonicalJson(props.columnCaptions),
    columnDisplayFormats: props.columnDisplayFormats === undefined ? null : canonicalJson(props.columnDisplayFormats),
    readOnly: props.readOnly ?? null,
    readOnlyColumns: props.readOnlyColumns === undefined ? null : [...props.readOnlyColumns].sort(),
    // DD-036: 行 readOnly は集合＝ソート。固定行列数は素の数値。列背景 Record はキー順非依存で正準化。
    readOnlyRows: props.readOnlyRows === undefined ? null : [...props.readOnlyRows].sort(),
    frozenRowCount: props.frozenRowCount ?? null,
    frozenColumnCount: props.frozenColumnCount ?? null,
    columnBackgrounds: props.columnBackgrounds === undefined ? null : canonicalJson(props.columnBackgrounds),
    rowBackgrounds: props.rowBackgrounds === undefined ? null : canonicalJson(props.rowBackgrounds),
    rowBorders: props.rowBorders === undefined ? null : canonicalJson(props.rowBorders),
    columnBorders: props.columnBorders === undefined ? null : canonicalJson(props.columnBorders),
  });
}

/**
 * 初期値系 props の参照スナップショット（変更検知＝無視＋warn 判定用）。
 * **参照比較のみ**にして毎 render の直列化を避ける（Codex P1: 数万行 initialData の JSON.stringify を毎 render しない）。
 * 利用側が同一オブジェクトを保持していれば変更なしと判定し、新規オブジェクトを渡したら「変更＝無視」と警告する。
 */
interface InitialSnapshot {
  readonly data: GridStandaloneData | undefined;
  readonly columnWidths: Readonly<Record<string, number>> | undefined;
  readonly rowHeights: Readonly<Record<string, number>> | undefined;
}
function initialSnapshotOf(props: NanairoSheetViewProps): InitialSnapshot {
  return {
    data: props.mode === 'standalone' ? props.initialData : undefined,
    columnWidths: props.initialColumnWidths,
    rowHeights: props.initialRowHeights,
  };
}
function sameInitialSnapshot(a: InitialSnapshot, b: InitialSnapshot): boolean {
  return (
    Object.is(a.data, b.data) &&
    Object.is(a.columnWidths, b.columnWidths) &&
    Object.is(a.rowHeights, b.rowHeights)
  );
}

/** props → GridMountOptions（判別 union 写像・契約 §1）。onEvent/onDiagnostic は Facade が張る安定口。 */
function toMountOptions(
  props: NanairoSheetViewProps,
  onEvent: (event: GridEvent) => void,
  onDiagnostic: GridDiagnosticHook | undefined,
): GridMountOptions {
  const common = {
    columnWidths: props.initialColumnWidths,
    rowHeights: props.initialRowHeights,
    wrapColumns: props.wrapColumns,
    // DD-035: 列スキーマ系（grid 同名オプションへ 1:1）。undefined はそのまま渡す（grid 側で未指定＝現行挙動）。
    columnTypes: props.columnTypes,
    columnFormats: props.columnFormats,
    columnCaptions: props.columnCaptions,
    columnDisplayFormats: props.columnDisplayFormats,
    readOnly: props.readOnly,
    readOnlyColumns: props.readOnlyColumns,
    // DD-036: 固定行列数・列背景・行 readOnly（undefined はそのまま渡す＝grid 側で未指定＝現行挙動）。
    readOnlyRows: props.readOnlyRows,
    frozenRowCount: props.frozenRowCount,
    frozenColumnCount: props.frozenColumnCount,
    columnBackgrounds: props.columnBackgrounds,
    rowBackgrounds: props.rowBackgrounds,
    rowBorders: props.rowBorders,
    columnBorders: props.columnBorders,
    onEvent,
    onDiagnostic,
  };
  if (props.mode === 'standalone') {
    return {
      ...common,
      mode: 'standalone',
      columnOrder: props.columnOrder,
      documentId: props.documentId,
      initialData: props.initialData,
    };
  }
  return {
    ...common,
    mode: props.mode,
    serverUrl: props.serverUrl,
    columnOrder: props.columnOrder,
    documentId: props.documentId,
    displayName: props.displayName,
    clientId: props.clientId,
  };
}

function NanairoSheetViewImpl(
  props: NanairoSheetViewProps,
  ref: ForwardedRef<NanairoSheetViewHandle>,
): ReturnType<typeof createElement> {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<GridInstance | null>(null);
  const callbacksRef = useRef<CallbackBag>({});
  /** 直近の接続状態（'pending' イベントは state を持たないため補う）。mount 時に instance の値で初期化する。 */
  const lastConnStateRef = useRef<GridConnectionState>('stopped');
  /** 最後に mount した時点の初期値系スナップショット（参照比較で変更検知＝無視＋warn 判定用）。 */
  const mountedInitialRef = useRef<InitialSnapshot>({
    data: undefined,
    columnWidths: undefined,
    rowHeights: undefined,
  });
  /** 診断 warn 用に最新 props を保持（onDiagnostic/mode を参照するため）。 */
  const propsRef = useRef<NanairoSheetViewProps>(props);
  /** 最新の onDiagnostic を保持（grid へ渡す安定ラッパーが読む・後差し替え対応。Codex P2）。 */
  const diagnosticRef = useRef<GridDiagnosticHook | undefined>(props.onDiagnostic);

  // 最新の callback / props / diagnostic を **commit 後**に ref へ反映する（差し替えで remount しない・契約 §4 分類3）。
  // render 中ではなく useLayoutEffect で更新する: Concurrent React（startTransition/Suspense）で **未 commit の
  // render** が共有 ref を汚し、現行 instance のイベントが破棄された render の callback を呼ぶのを防ぐ（Codex P1）。
  useLayoutEffect(() => {
    callbacksRef.current = {
      onCellCommit: props.onCellCommit,
      onLayout: props.onLayout,
      onConnectionChange: props.onConnectionChange,
      onError: props.onError,
      onEvent: props.onEvent,
    };
    propsRef.current = props;
    diagnosticRef.current = props.onDiagnostic;
  });

  const mountKey = mountKeyOf(props);
  const currentInitial = initialSnapshotOf(props);

  // 命令 API（ref handle）。instanceRef を都度参照し、未 mount 時は安全に no-op / 既定値（契約 §3）。
  useImperativeHandle(
    ref,
    (): NanairoSheetViewHandle => ({
      setData(data: GridStandaloneData): void {
        const instance = instanceRef.current;
        if (instance === null) {
          warnFacade(propsRef.current, 'handle-before-mount', 'setData を mount 前に呼びました（無視）。');
          return;
        }
        instance.setData(data);
      },
      focus(): void {
        const instance = instanceRef.current;
        if (instance === null) {
          warnFacade(propsRef.current, 'handle-before-mount', 'focus を mount 前に呼びました（無視）。');
          return;
        }
        instance.focus();
      },
      connectionState(): GridConnectionState {
        return instanceRef.current?.connectionState() ?? 'stopped';
      },
      // DD-035 R7/R6: GridInstance 直結。未 mount は setData/focus と同じく warn して無視（契約 §3）。
      insertRows(options): void {
        const instance = instanceRef.current;
        if (instance === null) {
          warnFacade(propsRef.current, 'handle-before-mount', 'insertRows を mount 前に呼びました（無視）。');
          return;
        }
        instance.insertRows(options);
      },
      deleteRows(rowIds): void {
        const instance = instanceRef.current;
        if (instance === null) {
          warnFacade(propsRef.current, 'handle-before-mount', 'deleteRows を mount 前に呼びました（無視）。');
          return;
        }
        instance.deleteRows(rowIds);
      },
      scrollToRow(rowId): void {
        const instance = instanceRef.current;
        if (instance === null) {
          warnFacade(propsRef.current, 'handle-before-mount', 'scrollToRow を mount 前に呼びました（無視）。');
          return;
        }
        instance.scrollToRow(rowId);
      },
      scrollToColumn(columnId): void {
        const instance = instanceRef.current;
        if (instance === null) {
          warnFacade(propsRef.current, 'handle-before-mount', 'scrollToColumn を mount 前に呼びました（無視）。');
          return;
        }
        instance.scrollToColumn(columnId);
      },
      setActiveCell(rowId, columnId): void {
        const instance = instanceRef.current;
        if (instance === null) {
          warnFacade(propsRef.current, 'handle-before-mount', 'setActiveCell を mount 前に呼びました（無視）。');
          return;
        }
        instance.setActiveCell(rowId, columnId);
      },
    }),
    [],
  );

  // lifecycle: 識別系（mountKey）が変わるたび destroy→mount（自動 remount・契約 §4 分類1）。
  // StrictMode（dev）の mount→cleanup→mount も cleanup の destroy で leak-free（AC5・AC6）。
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const onEvent = (event: GridEvent): void => {
      const cb = callbacksRef.current;
      cb.onEvent?.(event);
      switch (event.type) {
        case 'cell-commit':
          cb.onCellCommit?.(event.changes);
          break;
        case 'layout':
          cb.onLayout?.(event.columnWidths, event.rowHeights);
          break;
        case 'error':
          cb.onError?.({ phase: event.phase, code: event.code, message: event.message });
          break;
        case 'connection':
          lastConnStateRef.current = event.state;
          cb.onConnectionChange?.(event.state, event.pendingCount);
          break;
        case 'pending':
          cb.onConnectionChange?.(lastConnStateRef.current, event.pendingCount);
          break;
        // rejected / divergence は onEvent 素通しのみ（Alpha は通知まで・契約 §2）。
        default:
          break;
      }
    };

    // grid へ渡す診断口は「mount 時に onDiagnostic があれば」安定ラッパー（最新 ref を読む＝後差し替え対応・Codex P2）。
    // mount 時に未指定なら undefined を渡し grid の診断を生成させない（zero-cost opt-in を維持・§8）。
    const onDiagnostic: GridDiagnosticHook | undefined =
      propsRef.current.onDiagnostic !== undefined
        ? (entry) => diagnosticRef.current?.(entry)
        : undefined;

    const instance = mount({ container }, toMountOptions(propsRef.current, onEvent, onDiagnostic));
    instanceRef.current = instance;
    // 接続状態キャッシュを instance の実値で初期化する（remount で旧状態を引き継がず、
    // 初回 connection 前の pending も現 instance の状態で通知する・Codex P2）。
    lastConnStateRef.current = instance.connectionState();
    mountedInitialRef.current = initialSnapshotOf(propsRef.current);

    return () => {
      instance.destroy();
      instanceRef.current = null;
    };
    // deps は識別系の値比較キー（mountKey）のみ。初期値系/callback は propsRef/callbacksRef 経由で参照する（契約 §4）。
    // （react-hooks/exhaustive-deps プラグインは本 repo では未設定のため disable ディレクティブは付けない。）
  }, [mountKey]);

  // 初期値系（initialData/initialColumnWidths/initialRowHeights）の変更は無視＋診断 warn（契約 §4 分類2）。
  // **参照比較**で判定する（毎 render の直列化なし・Codex P1）。mountKey 変更に伴う remount では mount effect が
  // スナップショットを再取得するため warn しない（mount effect が本 effect より先に走る）。
  useEffect(() => {
    if (instanceRef.current === null) return;
    if (sameInitialSnapshot(currentInitial, mountedInitialRef.current)) return;
    warnFacade(
      propsRef.current,
      'initial-prop-ignored',
      '初期値系 props（initialData/initialColumnWidths/initialRowHeights）の変更は mount 後は無視されます。' +
        'データ再注入は ref.setData、レイアウトは onLayout→次回 mount を使ってください。',
    );
    mountedInitialRef.current = currentInitial;
  }, [currentInitial.data, currentInitial.columnWidths, currentInitial.rowHeights]);

  return createElement('div', {
    ref: containerRef,
    className: props.className,
    style: props.style,
  });
}

/**
 * Nanairo Sheet を React から使うコンポーネント（憲章 §11.2）。lifecycle と props/event 変換のみを担当し、
 * グリッド内部状態を React state へ複製しない。命令操作（再注入/focus）は ref（NanairoSheetViewHandle）。
 */
export const NanairoSheetView = forwardRef<NanairoSheetViewHandle, NanairoSheetViewProps>(
  NanairoSheetViewImpl,
);
NanairoSheetView.displayName = 'NanairoSheetView';
