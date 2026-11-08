// サイズのガード（DD-065）の単体テスト。計測（measure.mjs）と判定（evaluate.mjs）を fixture で確かめる。
import { describe, expect, it } from 'vitest';
import { countLines, measureSource } from '../../scripts/size-guard/measure.mjs';
import { evaluate, tightenBaseline } from '../../scripts/size-guard/evaluate.mjs';

type Fn = { key: string; complexity: number; line: number };
type Metric = { path: string; lines: number; functions: Fn[] };
type Entry = { lines?: number; complexity?: number; exception?: { dd: string; reason: string } };
type Baseline = { version: number; files: Record<string, Entry>; functions: Record<string, Entry> };

const T = { fileLines: 5, complexity: 3 };
const ddExists = (dd: string) => dd === 'DD-065';

function metric(path: string, lines: number, fns: Array<[string, number]> = []): Metric {
  return { path, lines, functions: fns.map(([key, complexity]) => ({ key, complexity, line: 1 })) };
}

function baselineOf(files: Record<string, Entry>, functions: Record<string, Entry> = {}): Baseline {
  return { version: 1, files, functions };
}

/** 違反: big.ts（10 行 > 5）と big.ts::f（複雑度 5 > 3）。small.ts は上限以下。 */
const METRICS = [metric('big.ts', 10, [['f', 5]]), metric('small.ts', 2, [['g', 1]])];
const EXACT = baselineOf({ 'big.ts': { lines: 10 } }, { 'big.ts::f': { complexity: 5 } });

function run(metrics: Metric[], baseline: Baseline, baseBaseline: Baseline | null = EXACT) {
  return evaluate({ metrics, baseline, baseBaseline, thresholds: T, ddExists });
}
const kinds = (r: { errors: { kind: string }[] }) => r.errors.map((e) => e.kind);

describe('measure: 行数', () => {
  it('wc -l と同じく末尾の改行の後ろは数えない', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\r\nb\r\n')).toBe(2);
  });
});

describe('measure: 循環的複雑度と関数のキー', () => {
  it('分岐を数え、入れ子の関数は別に測る', () => {
    const src = [
      'export function outer(a: number, b?: string) {',
      '  if (a > 1 && b) { return 1; }',
      '  const inner = () => (a ? 1 : 2);',
      '  for (const x of [1]) { void x; }',
      '  switch (a) { case 1: break; case 2: break; default: break; }',
      '  try { void inner(); } catch { void 0; }',
      "  return b ?? 'x';",
      '}',
    ].join('\n');
    const { functions } = measureSource('x.ts', src);
    // outer: 1 + if + && + for-of + case×2 + catch + ?? = 8（default と入れ子の三項は数えない）
    expect(functions).toEqual([
      { key: 'outer', complexity: 8, line: 1 },
      { key: 'outer>inner', complexity: 2, line: 3 },
    ]);
  });

  it('名前の無い関数は置かれ方から名付け、重なりは出現順に #2 を付ける', () => {
    const src = [
      'function wire(el: HTMLElement) {',
      "  el.addEventListener('pointerdown', (e) => { if (e) { void e; } });",
      "  el.addEventListener('pointerdown', () => {});",
      '  let slot: (() => void) | undefined;',
      '  slot = () => {};',
      '  const api = { open: () => {}, close() {} };',
      '  return [api, slot];',
      '}',
    ].join('\n');
    expect(measureSource('x.ts', src).functions.map((f) => f.key)).toEqual([
      'wire',
      'wire>addEventListener:pointerdown',
      'wire>addEventListener:pointerdown#2',
      'wire>slot',
      'wire>open',
      'wire>close',
    ]);
  });

  it('行がずれてもキーは変わらない', () => {
    const src = "function a() { const b = () => 1; return b; }\nexport const c = { d() { return 1; } };\n";
    const shifted = `// 先頭に足したコメント\n\n\n${src}`;
    const keys = (text: string) => measureSource('x.ts', text).functions.map((f) => f.key);
    expect(keys(shifted)).toEqual(keys(src));
    expect(measureSource('x.ts', shifted).lines).toBe(measureSource('x.ts', src).lines + 3);
  });
});

describe('evaluate: 今の値を baseline に照らす', () => {
  it('baseline どおりなら失敗しない', () => {
    expect(run(METRICS, EXACT).errors).toEqual([]);
  });

  it('baseline に無い新しい超過は失敗', () => {
    const r = run([...METRICS.slice(0, 1), metric('small.ts', 6)], EXACT);
    expect(kinds(r)).toEqual(['new-violation']);
  });

  it('baseline より増えたら失敗', () => {
    expect(kinds(run([metric('big.ts', 11, [['f', 5]])], EXACT))).toEqual(['grew']);
    expect(kinds(run([metric('big.ts', 10, [['f', 6]])], EXACT))).toEqual(['grew']);
  });

  it('減ったのに baseline を下げていなければ失敗（減った分を固定する）', () => {
    expect(kinds(run([metric('big.ts', 9, [['f', 5]])], EXACT))).toEqual(['not-tightened']);
  });

  it('もう上限を超えていない・無くなった項目が baseline に残っていれば失敗', () => {
    expect(kinds(run([metric('big.ts', 10, [['f', 3]])], EXACT))).toEqual(['stale']);
    expect(kinds(run([metric('big.ts', 10, [])], EXACT))).toEqual(['stale']);
  });

  it('version が違えば失敗', () => {
    expect(kinds(run(METRICS, { ...EXACT, version: 2 }))).toEqual(['bad-version']);
  });

  it('手編集で数値を文字列・null・欠落・小数等へ壊しても、増加が比較をすり抜けない', () => {
    for (const value of ['invalid', null, undefined, -1, 10.5, Infinity, Number.NaN]) {
      const malformed = structuredClone(EXACT);
      Object.assign(malformed.files['big.ts'] ?? {}, { lines: value });
      Object.assign(malformed.functions['big.ts::f'] ?? {}, { complexity: value });
      expect(kinds(run([metric('big.ts', 12, [['f', 7]])], malformed))).toEqual(['bad-entry', 'bad-entry']);
    }
  });

  it('比較元の数値が不正な場合も、baseline の引き上げを通さない', () => {
    const malformed = structuredClone(EXACT);
    Object.assign(malformed.files['big.ts'] ?? {}, { lines: 'invalid' });
    expect(kinds(run(METRICS, EXACT, malformed))).toEqual(['bad-entry']);
  });
});

describe('evaluate: baseline 自体を比較元と比べる（手での書き換えも検出）', () => {
  const raised = (exception?: Entry['exception']) =>
    baselineOf({ 'big.ts': exception ? { lines: 12, exception } : { lines: 12 } }, { 'big.ts::f': { complexity: 5 } });
  const grown = [metric('big.ts', 12, [['f', 5]])];

  it('baseline.json の値を手で上げても、exception が無ければ失敗', () => {
    expect(kinds(run(grown, raised()))).toEqual(['baseline-raised']);
  });

  it('DD 番号と理由つきの exception があれば通し、知らせる', () => {
    const r = run(grown, raised({ dd: 'DD-065', reason: '分割の途中で一時的に増える' }));
    expect(r.errors).toEqual([]);
    expect(r.notices.map((n) => n.kind)).toEqual(['exception']);
  });

  it('exception の DD が存在しない・形が違う・理由が空なら失敗', () => {
    expect(kinds(run(grown, raised({ dd: 'DD-999', reason: '理由' })))).toEqual(['baseline-raised']);
    expect(kinds(run(grown, raised({ dd: 'DD65', reason: '理由' })))).toEqual(['baseline-raised']);
    expect(kinds(run(grown, raised({ dd: 'DD-065', reason: ' ' })))).toEqual(['baseline-raised']);
  });

  it('比較元に無い項目を baseline へ手で足すと、exception が無ければ失敗', () => {
    const added = baselineOf({ 'big.ts': { lines: 10 }, 'small.ts': { lines: 6 } }, { 'big.ts::f': { complexity: 5 } });
    expect(kinds(run([...METRICS.slice(0, 1), metric('small.ts', 6)], added))).toEqual(['baseline-added']);
  });

  it('比較元に baseline が無ければ（初回）、baseline 自体の比較はせず知らせる', () => {
    const r = run(METRICS, EXACT, null);
    expect(r.errors).toEqual([]);
    expect(r.notices.map((n) => n.kind)).toEqual(['no-base']);
  });

  it('baseline を下げる・外すのは比較元に関係なく通る', () => {
    const lowered = baselineOf({ 'big.ts': { lines: 9 } }, {});
    expect(run([metric('big.ts', 9, [['f', 2]])], lowered).errors).toEqual([]);
  });
});

describe('tightenBaseline: 減った値を固定する（増やす・足すことはしない）', () => {
  it('減った値へ下げ、もう超えていない項目を外す', () => {
    const { baseline, refused } = tightenBaseline({ metrics: [metric('big.ts', 8, [['f', 2]])], baseline: EXACT, thresholds: T });
    expect(refused).toEqual([]);
    expect(baseline).toEqual(baselineOf({ 'big.ts': { lines: 8 } }, {}));
  });

  it('増えた項目・新しい超過は更新を断る', () => {
    const grew = tightenBaseline({ metrics: [metric('big.ts', 12, [['f', 5]])], baseline: EXACT, thresholds: T });
    expect(grew.refused.map((r) => r.id)).toEqual(['big.ts']);
    const added = tightenBaseline({ metrics: [...METRICS, metric('new.ts', 7)], baseline: EXACT, thresholds: T });
    expect(added.refused.map((r) => r.id)).toEqual(['new.ts']);
  });

  it('初回（baseline が無い）だけ、今の超過をそのまま載せる', () => {
    const { baseline, refused } = tightenBaseline({ metrics: METRICS, baseline: null, thresholds: T, initial: true });
    expect(refused).toEqual([]);
    expect(baseline).toEqual(EXACT);
  });

  it('exception は下げても残す', () => {
    const exception = { dd: 'DD-065', reason: '理由' };
    const withEx = baselineOf({ 'big.ts': { lines: 12, exception } }, { 'big.ts::f': { complexity: 5 } });
    const { baseline } = tightenBaseline({ metrics: [metric('big.ts', 11, [['f', 5]])], baseline: withEx, thresholds: T });
    expect(baseline.files['big.ts']).toEqual({ lines: 11, exception });
  });

  it('数値が不正な baseline は update-baseline でも上書きせず、修正を求める', () => {
    const malformed = structuredClone(EXACT);
    Object.assign(malformed.files['big.ts'] ?? {}, { lines: 'invalid' });
    const result = tightenBaseline({ metrics: [metric('big.ts', 12, [['f', 5]])], baseline: malformed, thresholds: T });
    expect(result.refused.map((entry) => entry.id)).toEqual(['big.ts']);
  });
});
