// 生 IME イベントレコーダー（Appendix B `ImeEventTrace` 形式）。
//
// トレース先行方針（DD-002）の中核。実 IME の生イベント列を先に採取し、
// scenarios.md と編集状態機械（Phase 3）を実挙動から確定するための土台。
//
// 【設計方針】
// - このモジュールは **DOM に一切依存しない**（UI 非依存）。DOM の Event からの
//   フィールド抽出は呼び出し側（resident-textarea の DOM アダプタ）が行い、ここへは
//   `RecorderEventSnapshot`（構造的スナップショット）として渡す。これにより整形ロジックを
//   node 環境の vitest で synthetic オブジェクト駆動のユニットテストにかけられる。
// - recorder は入力挙動へ干渉しない（記録のみ）。呼び出し側はイベント受信直後・
//   `preventDefault` より前に `record()` を呼ぶ（DA #5）。将来 `sheet-editor-ime` へ移設しやすい。

/** トレースが指すセル位置（Appendix B の activeCell。PoC では row/col インデックス）。 */
export interface TraceCell {
  readonly row: number;
  readonly col: number;
}

/** 採取環境。os/browser は userAgent 推定、ime は不明として手入力で埋める（空可）。 */
export interface TraceEnvironment {
  readonly browser: string;
  readonly os: string;
  readonly ime: string;
}

/**
 * 1 イベント分のトレース記録（計画書 Appendix B `ImeEventTrace`）。
 * イベント種別ごとに意味のあるフィールドだけを持つ（整形は `formatTrace`）。
 */
export interface ImeEventTrace {
  readonly timestamp: number;
  readonly browser: string;
  readonly os: string;
  readonly ime: string;
  readonly state: string;
  readonly eventType: string;
  readonly key?: string | undefined;
  readonly code?: string | undefined;
  readonly isComposing?: boolean | undefined;
  readonly inputType?: string | undefined;
  readonly data?: string | null;
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  readonly activeCell: TraceCell;
}

/** 記録対象のイベント種別（DOM イベント名に一致。§11.5 の監視対象）。 */
export type RecordedEventType =
  | 'compositionstart'
  | 'compositionupdate'
  | 'compositionend'
  | 'beforeinput'
  | 'input'
  | 'keydown'
  | 'keyup'
  | 'focus'
  | 'blur'
  | 'pointerdown';

/**
 * DOM イベント + textarea から抽出した構造的スナップショット（DOM 型に非依存）。
 * DOM アダプタ（resident-textarea）が組み立て、`record()` へ渡す。
 */
export interface RecorderEventSnapshot {
  readonly type: RecordedEventType;
  /** 記録時刻（ms）。DOM 非依存にするため呼び出し側が供給（例: `performance.now()`）。 */
  readonly timestamp: number;
  /** KeyboardEvent 由来（keydown/keyup）。 */
  readonly key?: string;
  readonly code?: string;
  /** keydown/keyup/input の合成状態。 */
  readonly isComposing?: boolean;
  /** InputEvent 由来（beforeinput/input）。 */
  readonly inputType?: string;
  /** composition / input 由来のテキストデータ（input では null になりうる）。 */
  readonly data?: string | null;
  /** textarea のスナップショット（値の正・§11.5 I-1）。 */
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

/** 記録時の文脈（環境・粗い状態ラベル・アクティブセル）。 */
export interface RecorderContext {
  readonly environment: TraceEnvironment;
  /** 粗い状態ラベル（Navigation/Editing/Composing）。Phase 3 の状態機械が正式化する。 */
  readonly state: string;
  readonly activeCell: TraceCell;
}

/**
 * スナップショット + 文脈から `ImeEventTrace` を組み立てる（純粋関数）。
 * イベント種別ごとに意味のあるフィールドだけを載せ、無関係なフィールド
 * （例: keydown に inputType）を混ぜない。ここが整形ロジックの検証対象。
 */
export function formatTrace(
  snapshot: RecorderEventSnapshot,
  context: RecorderContext,
): ImeEventTrace {
  const base: ImeEventTrace = {
    timestamp: snapshot.timestamp,
    browser: context.environment.browser,
    os: context.environment.os,
    ime: context.environment.ime,
    state: context.state,
    eventType: snapshot.type,
    value: snapshot.value,
    selectionStart: snapshot.selectionStart,
    selectionEnd: snapshot.selectionEnd,
    // 呼び出し側の可変参照を取り込まないようコピーする（トレースの不変性）。
    activeCell: { row: context.activeCell.row, col: context.activeCell.col },
  };

  switch (snapshot.type) {
    case 'keydown':
    case 'keyup':
      return {
        ...base,
        key: snapshot.key,
        code: snapshot.code,
        isComposing: snapshot.isComposing,
      };
    case 'beforeinput':
    case 'input':
      return {
        ...base,
        inputType: snapshot.inputType,
        data: snapshot.data ?? null,
        isComposing: snapshot.isComposing,
      };
    case 'compositionstart':
    case 'compositionupdate':
    case 'compositionend':
      return { ...base, data: snapshot.data ?? null };
    case 'focus':
    case 'blur':
    case 'pointerdown':
      return base;
  }
}

/** userAgent から browser / os を推定する（ime は実 IME を特定できないため対象外）。 */
export function detectEnvironment(userAgent: string): { browser: string; os: string } {
  let browser = 'Unknown';
  // Edge(Chromium) は "Edg/" を含み Chrome より先に判定する（UA に Chrome も含むため）。
  if (/\bEdg(?:A|iOS)?\//.test(userAgent)) {
    browser = 'Edge';
  } else if (/\bOPR\/|\bOpera\b/.test(userAgent)) {
    browser = 'Opera';
  } else if (/\b(?:Chrome|CriOS)\//.test(userAgent)) {
    browser = 'Chrome';
  } else if (/\b(?:Firefox|FxiOS)\//.test(userAgent)) {
    browser = 'Firefox';
  } else if (/\bSafari\//.test(userAgent)) {
    browser = 'Safari';
  }

  let os = 'Unknown';
  if (/Windows NT/.test(userAgent)) {
    os = 'Windows';
  } else if (/Mac OS X/.test(userAgent)) {
    os = 'macOS';
  } else if (/Android/.test(userAgent)) {
    os = 'Android';
  } else if (/(?:iPhone|iPad|iPod)/.test(userAgent)) {
    os = 'iOS';
  } else if (/Linux/.test(userAgent)) {
    os = 'Linux';
  }

  return { browser, os };
}

/** 変更通知の購読解除関数。 */
export type Unsubscribe = () => void;

/** 生イベントレコーダー（記録の蓄積・取得・消去・購読）。 */
export interface EventRecorder {
  /** 1 イベントを記録する（整形して末尾へ追加し、購読者へ通知）。 */
  record(snapshot: RecorderEventSnapshot, context: RecorderContext): void;
  /** 記録全体のスナップショット（古い順）。エクスポート用。 */
  getTraces(): readonly ImeEventTrace[];
  /** 直近 count 件（古い→新しい順）。パネル表示用。 */
  getRecent(count: number): readonly ImeEventTrace[];
  /** 記録件数。 */
  size(): number;
  /** 記録を全消去する（件数が変わったときだけ通知）。 */
  clear(): void;
  /** 記録変化を購読する（パネル再描画用）。 */
  subscribe(listener: () => void): Unsubscribe;
}

/** イベントレコーダーを生成する。 */
export function createEventRecorder(): EventRecorder {
  const traces: ImeEventTrace[] = [];
  const listeners = new Set<() => void>();

  const notify = (): void => {
    // 通知中の購読解除に備えてスナップショットを回す（cell-store と同方針）。
    for (const listener of [...listeners]) {
      listener();
    }
  };

  return {
    record(snapshot, context) {
      traces.push(formatTrace(snapshot, context));
      notify();
    },
    getTraces() {
      return traces.slice();
    },
    getRecent(count) {
      if (count <= 0) {
        return [];
      }
      return traces.slice(Math.max(0, traces.length - count));
    },
    size() {
      return traces.length;
    },
    clear() {
      if (traces.length === 0) {
        return;
      }
      traces.length = 0;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
