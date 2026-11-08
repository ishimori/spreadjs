// サイズのガード（DD-065）— 判定。計測結果を baseline と、比較元の baseline に照らす（純関数・I/O なし）。
//
// 規則（AGENTS.md「サイズのガード」・DD-065 論点5）:
//   1. 閾値を超えるファイル・関数は baseline に載っていなければ失敗（新しい超過）
//   2. baseline に載っている値より増えたら失敗。減ったのに baseline を下げていなければ失敗（減った分を固定する）
//   3. baseline に載っているのに、もう閾値を超えていない・無くなった項目は失敗（baseline から外す）
//   4. baseline 自体を比較元（ローカルは HEAD、CI は push 前のコミット・PR のベース）と比べ、値の引き上げと
//      項目の追加は、その項目に exception（dd: DD 番号・reason: 理由）があり、その DD が存在するときだけ通す。
//      baseline.json を手で書き換えても、この比較で見つかる。

export const BASELINE_VERSION = 1;

const DD_ID = /^DD-\d{3}(?:-\d+)*$/;

const SECTIONS = [
  { name: 'files', field: 'lines', thresholdKey: 'fileLines', label: 'ファイルの行数' },
  { name: 'functions', field: 'complexity', thresholdKey: 'complexity', label: '関数の循環的複雑度' },
];

/** 関数のキー（ファイルのパス::関数の道筋）。 */
export function functionId(path, key) {
  return `${path}::${key}`;
}

/** 閾値を超えている項目（ファイル・関数）を集める。 */
export function collectViolations(metrics, thresholds) {
  const files = new Map();
  const functions = new Map();
  for (const m of metrics) {
    if (m.lines > thresholds.fileLines) files.set(m.path, m.lines);
    for (const f of m.functions) {
      if (f.complexity > thresholds.complexity) functions.set(functionId(m.path, f.key), f.complexity);
    }
  }
  return { files, functions };
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

/** JSON の数値を壊しても、NaN との比較でガードをすり抜けさせない。 */
function validMeasurement(entry, field) {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && Number.isSafeInteger(entry[field]) && entry[field] >= 0;
}

function measurementErrors(baseline, label) {
  const errors = [];
  for (const section of SECTIONS) {
    const recorded = baseline[section.name] ?? {};
    if (typeof recorded !== 'object' || Array.isArray(recorded)) {
      errors.push({ kind: 'bad-section', id: section.name, message: `${label}の ${section.name} はオブジェクトが必要です` });
      continue;
    }
    for (const [id, entry] of Object.entries(recorded)) {
      if (!validMeasurement(entry, section.field)) {
        errors.push({ kind: 'bad-entry', id, message: `${id}: ${label}の ${section.field} は非負の安全な整数が必要です` });
      }
    }
  }
  return errors;
}

/** exception の不備を 1 つ返す（問題が無ければ null）。 */
export function exceptionProblem(entry, ddExists) {
  const ex = entry?.exception;
  if (ex === undefined || ex === null) return 'exception（dd・reason）がありません';
  if (typeof ex.dd !== 'string' || !DD_ID.test(ex.dd)) return 'exception.dd が DD 番号の形（例: DD-065）ではありません';
  if (!ddExists(ex.dd)) return `exception.dd の ${ex.dd} が doc/DD にも doc/archived/DD にもありません`;
  if (typeof ex.reason !== 'string' || ex.reason.trim() === '') return 'exception.reason が空です';
  return null;
}

/**
 * 判定する。
 * @param {{
 *   metrics: { path: string, lines: number, functions: { key: string, complexity: number }[] }[],
 *   baseline: { version?: number, files?: Record<string, object>, functions?: Record<string, object> },
 *   baseBaseline: { files?: Record<string, object>, functions?: Record<string, object> } | null,
 *   thresholds: { fileLines: number, complexity: number },
 *   ddExists: (dd: string) => boolean,
 *   baseLabel?: string,
 * }} input
 */
export function evaluate({ metrics, baseline, baseBaseline, thresholds, ddExists, baseLabel = '比較元' }) {
  const errors = [];
  const notices = [];
  if (baseline.version !== BASELINE_VERSION) {
    errors.push({ kind: 'bad-version', id: 'baseline.json', message: `baseline.json の version が ${BASELINE_VERSION} ではありません` });
    return { errors, notices };
  }
  errors.push(...measurementErrors(baseline, 'baseline'));
  if (baseBaseline !== null) errors.push(...measurementErrors(baseBaseline, baseLabel));
  if (errors.length > 0) return { errors, notices };
  const violations = collectViolations(metrics, thresholds);
  for (const section of SECTIONS) {
    const current = violations[section.name];
    const recorded = baseline[section.name] ?? {};
    const limit = thresholds[section.thresholdKey];

    for (const [id, value] of current) {
      const entry = recorded[id];
      if (entry === undefined) {
        errors.push({ kind: 'new-violation', id, message: `${id}: ${section.label} ${fmt(value)}（上限 ${fmt(limit)}）。baseline に無い新しい超過です。分けて上限以下にしてください` });
      } else if (value > entry[section.field]) {
        errors.push({ kind: 'grew', id, message: `${id}: ${section.label} ${fmt(value)}（baseline ${fmt(entry[section.field])}）。baseline の項目は増やせません。切り出して減らしてください` });
      } else if (value < entry[section.field]) {
        errors.push({ kind: 'not-tightened', id, message: `${id}: ${section.label} ${fmt(value)}（baseline ${fmt(entry[section.field])}）。減った分を固定するため npm run lint:size -- --update-baseline を実行してください` });
      }
    }
    for (const id of Object.keys(recorded)) {
      if (!current.has(id)) {
        errors.push({ kind: 'stale', id, message: `${id}: baseline にあるが、もう上限を超えていない（または無い）。npm run lint:size -- --update-baseline で外してください` });
      }
    }

    if (baseBaseline !== null) {
      const before = baseBaseline[section.name] ?? {};
      for (const [id, entry] of Object.entries(recorded)) {
        const prev = before[id];
        const added = prev === undefined;
        if (!added && !(entry[section.field] > prev[section.field])) continue;
        const problem = exceptionProblem(entry, ddExists);
        const change = added ? `追加（${fmt(entry[section.field])}）` : `${fmt(prev[section.field])} → ${fmt(entry[section.field])}`;
        if (problem === null) {
          notices.push({ kind: 'exception', id, message: `${id}: baseline を${added ? '追加' : '引き上げ'}（${change}・${entry.exception.dd}: ${entry.exception.reason}）` });
        } else {
          errors.push({ kind: added ? 'baseline-added' : 'baseline-raised', id, message: `${id}: baseline が${baseLabel}より${added ? '増えています' : '上がっています'}（${change}）。${problem}` });
        }
      }
    }
  }
  if (baseBaseline === null) {
    notices.push({ kind: 'no-base', id: 'baseline.json', message: `${baseLabel}に baseline が無いため、baseline 自体の増加は確かめていません` });
  }
  return { errors, notices };
}

/**
 * 減った値を baseline へ固定した次の baseline を作る（増やす・足すことはしない）。
 * initial=true（baseline がまだ無い）のときだけ、今の違反をそのまま載せる。
 * @returns {{ baseline: object, refused: { id: string, reason: string }[] }}
 */
export function tightenBaseline({ metrics, baseline, thresholds, initial = false }) {
  const violations = collectViolations(metrics, thresholds);
  const next = { version: BASELINE_VERSION, files: {}, functions: {} };
  const refused = [];
  for (const section of SECTIONS) {
    const recorded = baseline?.[section.name] ?? {};
    const ids = [...violations[section.name].keys()].sort();
    for (const id of ids) {
      const value = violations[section.name].get(id);
      const entry = recorded[id];
      if (entry === undefined && !initial) {
        refused.push({ id, reason: `baseline に無い新しい超過（${fmt(value)}）。分けて上限以下にするか、baseline.json に exception つきで手で足してください` });
        continue;
      }
      if (entry !== undefined && !validMeasurement(entry, section.field)) {
        refused.push({ id, reason: `baseline の ${section.field} が不正です。非負の安全な整数へ修正してください` });
        continue;
      }
      if (entry !== undefined && value > entry[section.field]) {
        refused.push({ id, reason: `baseline ${fmt(entry[section.field])} より大きい（${fmt(value)}）。切り出して減らすか、baseline.json の値を exception つきで手で上げてください` });
        continue;
      }
      next[section.name][id] = entry?.exception ? { [section.field]: value, exception: entry.exception } : { [section.field]: value };
    }
  }
  return { baseline: next, refused };
}
