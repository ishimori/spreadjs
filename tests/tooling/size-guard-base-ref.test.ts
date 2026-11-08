// 比較元の取得に失敗した CI がガードを省略しないことを、使い捨ての実 Git リポジトリで確かめる。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readBaseBaseline } from '../../scripts/size-guard/read-baseline.mjs';

const prefix = path.resolve(tmpdir(), 'spreadjs-size-guard-');
const repoRoot = mkdtempSync(prefix);
const baselineRel = 'scripts/size-guard/baseline.json';
const baseline = { version: 1, files: {}, functions: {} };
let beforeIntroduction: string;
let withBaseline: string;
let invalidJson: string;
let nullJson: string;
let invalidVersion: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(): string {
  git('add', '--', baselineRel);
  git('-c', 'user.name=Size Guard Test', '-c', 'user.email=size-guard@example.invalid', 'commit', '-m', 'fixture');
  return git('rev-parse', 'HEAD');
}

beforeAll(() => {
  git('init', '--quiet');
  git('-c', 'user.name=Size Guard Test', '-c', 'user.email=size-guard@example.invalid', 'commit', '--allow-empty', '-m', 'before baseline');
  beforeIntroduction = git('rev-parse', 'HEAD');
  mkdirSync(path.join(repoRoot, 'scripts/size-guard'), { recursive: true });
  writeFileSync(path.join(repoRoot, baselineRel), JSON.stringify(baseline));
  withBaseline = commit();
  writeFileSync(path.join(repoRoot, baselineRel), '{invalid json');
  invalidJson = commit();
  writeFileSync(path.join(repoRoot, baselineRel), 'null');
  nullJson = commit();
  writeFileSync(path.join(repoRoot, baselineRel), JSON.stringify({ ...baseline, version: 2 }));
  invalidVersion = commit();
});

afterAll(() => {
  // 再帰削除はこのテストが作った一時ディレクトリだけに制限する。
  const resolved = path.resolve(repoRoot);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !resolved.startsWith(prefix)) throw new Error('unexpected fixture path');
  rmSync(resolved, { recursive: true, force: true });
});

describe('size guard: 比較元の取得', () => {
  it('存在するコミットの baseline を読む', () => {
    expect(readBaseBaseline(repoRoot, withBaseline, baselineRel)).toEqual(baseline);
  });

  it('導入前のコミットと新規ブランチのゼロ SHA だけは、比較元なしを許容する', () => {
    expect(readBaseBaseline(repoRoot, beforeIntroduction, baselineRel)).toBeNull();
    expect(readBaseBaseline(repoRoot, '0'.repeat(40), baselineRel)).toBeNull();
  });

  it('履歴に無い SHA と不正な ref は、初回不在として扱わず失敗する', () => {
    expect(() => readBaseBaseline(repoRoot, 'f'.repeat(40), baselineRel)).toThrow('コミットを取得できません');
    expect(() => readBaseBaseline(repoRoot, '--invalid-ref', baselineRel)).toThrow('コミットを取得できません');
  });

  it('比較元の JSON が壊れていても、初回不在として扱わず失敗する', () => {
    expect(() => readBaseBaseline(repoRoot, invalidJson, baselineRel)).toThrow('JSON として読み取れません');
  });

  it('JSON の null や不正な version を、比較元なしの sentinel として扱わない', () => {
    expect(() => readBaseBaseline(repoRoot, nullJson, baselineRel)).toThrow('JSON として読み取れません');
    expect(() => readBaseBaseline(repoRoot, invalidVersion, baselineRel)).toThrow('JSON として読み取れません');
  });
});
