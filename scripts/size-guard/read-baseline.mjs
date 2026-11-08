// 比較元のコミットを解決してから baseline を読む。取得失敗と初回導入によるファイル不在を区別する。
import { execFileSync } from 'node:child_process';
import { BASELINE_VERSION } from './evaluate.mjs';

export function readBaseBaseline(repoRoot, ref, baselineRel) {
  if (ref === '' || /^0+$/.test(ref)) return null; // 新規ブランチの push には比較元が無い
  const git = (args) => execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let commit;
  try {
    commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`比較元（${ref}）のコミットを取得できません。履歴を取得するか SIZE_GUARD_BASE_REF を修正してください`);
  }
  let present;
  try {
    present = git(['ls-tree', '--name-only', commit, '--', baselineRel]).trim() !== '';
  } catch {
    throw new Error(`比較元（${ref}）のツリーを取得できません`);
  }
  if (!present) return null; // コミットは読めるが導入前でファイルが無い（正当な初回だけ許容）
  try {
    const parsed = JSON.parse(git(['show', `${commit}:${baselineRel}`]));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== BASELINE_VERSION) {
      throw new Error('baseline の形式が不正');
    }
    return parsed;
  } catch {
    throw new Error(`比較元（${ref}）の ${baselineRel} を正しい baseline の JSON として読み取れません`);
  }
}
