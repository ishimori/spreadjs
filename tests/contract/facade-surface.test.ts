// Facade 公開面 contract test（DD-016 で実 API 確定・DD-028 で型シグネチャ差分検出へ拡張）。
//
// ① export surface（公開 value シンボル名）を snapshot 契約として固定する（意図しない export の追加/削除で fail
//    ＝公開 API の破壊的変更検出・§2.3 公開API不変条件）。
// ② 公開 .d.ts snapshot（DD-028・S2-3）: Facade エントリの公開 .d.ts を in-memory で emit し、エントリから
//    相対 specifier（`from './x'`・`import("./x")`）で辿れる**公開宣言 closure 全文**を snapshot 固定する。
//    export 名が同じままの型シグネチャ変更（optional→必須・union 増減など破壊的変更の主形態）を検出する。
//    エントリ単独の .d.ts では `export type { GridConflictCode } from './error-codes'` しか現れず、
//    再エクスポート元モジュール内の型変更を検出できないため closure を対象にする。
//    注意（over-capture・安全側）: 再エクスポート元モジュールの非公開シンボル（例: grid の GridBootError／
//    toGridConflictCode）も closure に含まれる。それらの変更でも snapshot は fail するが、公開面への
//    影響が無ければ CHANGELOG には「公開API影響なし」と記録して更新すればよい。
// ③ R7 型漏洩0: 公開宣言 closure に内部パッケージ（core/collab/server/types/selection/render/ime/formula）の
//    specifier が現れないことを検証する（公開シグネチャへ内部型を漏らさない・境界文書 §4.2 R7。
//    boundary lint の AST 検査〔check.mjs〕と二重化）。react→grid の参照は Facade 公開型のため正当（R7 対象外）。
//
// 【意図的な surface 変更の手順（DD-028 4本柱運用）】
//   1. Facade の公開面（export・型シグネチャ）を変える。
//   2. `npx vitest run tests/contract -u` で snapshot を更新する。
//   3. 変更を CHANGELOG（Experimental `0.x`・ADR-0015・DD-017）へ記録し、DD の公開API影響へ明記する。
//   4. 破壊的変更なら migration guide の要否を判定する（運用規定: doc/migration/README.md）。
//   5. deprecation policy の適用（非推奨経由の要否・共存期間）を判定する（doc/product/deprecation-policy.md）。
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as grid from '@nanairo-sheet/grid';
import * as react from '@nanairo-sheet/react';
import * as serverHono from '@nanairo-sheet/server-hono';

const INTERNAL_PACKAGE_RE = /@nanairo-sheet\/(core|collab|server|types|selection|render|ime|formula)\b/;

/** contract 対象の Facade（consumer 公開面）。dir はリポジトリ相対の src ディレクトリ。 */
const FACADE_DIRS = {
  grid: 'packages/grid/src',
  serverHono: 'packages/server-hono/src',
  react: 'packages/react/src',
} as const;

function valueSurface(mod: Record<string, unknown>): string[] {
  return Object.keys(mod).sort();
}

// 公開 .d.ts の in-memory emit は ts.createProgram（lib 読込込み）のコールドコストが大きいため、
// 3 Facade のエントリを 1 program に束ねて一度だけ emit し、結果をモジュール内で共有する（DD-028）。
let emittedFacadeFiles: Map<string, string> | null = null;

/**
 * 3 Facade エントリを含む program を一度だけ emit し、Facade src 配下の公開 .d.ts を
 * 「リポジトリ相対 POSIX パス（.ts）→ .d.ts テキスト（LF 正規化済み）」で返す。
 * 内部 package（core/collab/…）の .d.ts は公開面ではないため収集しない。
 */
function facadeDeclarationFiles(): Map<string, string> {
  if (emittedFacadeFiles !== null) {
    return emittedFacadeFiles;
  }
  const rootAbs = fileURLToPath(new URL('../../', import.meta.url)).replace(/\\/g, '/');
  const entries = Object.values(FACADE_DIRS).map((dir) => `${rootAbs}${dir}/index.ts`);
  const program = ts.createProgram(entries, {
    declaration: true,
    emitDeclarationOnly: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true,
    skipLibCheck: true,
    types: ['node'],
    // snapshot の決定性: OS 既定（Windows CRLF）へ依存させず LF で emit する（CI=Linux と一致・DD-028）。
    newLine: ts.NewLineKind.LineFeed,
  });
  const captured = new Map<string, string>();
  program.emit(undefined, (fileName, data) => {
    const srcPath = fileName.replace(/\\/g, '/').replace(/\.d\.ts$/, '.ts');
    if (!srcPath.startsWith(rootAbs)) {
      return;
    }
    const rel = srcPath.slice(rootAbs.length);
    const isFacadeFile = Object.values(FACADE_DIRS).some((dir) => rel.startsWith(`${dir}/`));
    if (isFacadeFile) {
      // 改行を LF へ正規化し、TypeScript emitter がコメント付き引数へ付ける行末空白も除去する。
      // 公開型の意味に影響しない整形差で snapshot が揺れないようにする。
      captured.set(rel, data.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, ''));
    }
  });
  emittedFacadeFiles = captured;
  return captured;
}

/** .d.ts テキスト中の相対 specifier（re-export／inline import type）。パッケージ specifier は対象外。 */
const RELATIVE_SPEC_RE = /(?:from\s+|import\()['"](\.[^'"]+)['"]/g;

/** 相対 specifier を「リポジトリ相対 POSIX パス（拡張子なし）」へ解決する。 */
function resolveRelativeSpec(fromRel: string, spec: string): string {
  const parts = fromRel.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') {
      continue;
    }
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Facade エントリ（`<dir>/index.ts`）から相対 specifier で辿れる公開宣言 closure を、決定的順序
 * （エントリ→残りはパス昇順）で連結して返す。閉包にはエントリが re-export する公開モジュール
 * （grid の error-codes/diagnostics 等）が入り、実装専用モジュール（mount-controller 等）は入らない。
 */
function publicDeclarationClosure(facadeDir: string): string {
  const files = facadeDeclarationFiles();
  const entryRel = `${facadeDir}/index.ts`;
  if (!files.has(entryRel)) {
    throw new Error(`公開 .d.ts が emit されていません: ${entryRel}`);
  }
  const visited = new Set<string>([entryRel]);
  const ordered: string[] = [entryRel];
  for (let i = 0; i < ordered.length; i += 1) {
    const text = files.get(ordered[i]);
    if (text === undefined) {
      continue;
    }
    for (const match of text.matchAll(RELATIVE_SPEC_RE)) {
      const base = resolveRelativeSpec(ordered[i], match[1]);
      const candidate = [`${base}.ts`, `${base}/index.ts`].find((p) => files.has(p));
      if (candidate !== undefined && !visited.has(candidate)) {
        visited.add(candidate);
        ordered.push(candidate);
      }
    }
  }
  const rest = ordered.slice(1).sort();
  return [entryRel, ...rest]
    .map((rel) => `// ==== ${rel} ====\n${files.get(rel) ?? ''}`)
    .join('\n');
}

describe('contract: Facade export surface snapshot', () => {
  it('@nanairo-sheet/grid の公開 value surface', () => {
    expect(valueSurface(grid)).toMatchSnapshot();
  });

  it('@nanairo-sheet/server-hono の公開 value surface', () => {
    expect(valueSurface(serverHono)).toMatchSnapshot();
  });

  it('@nanairo-sheet/react の公開 value surface', () => {
    expect(valueSurface(react)).toMatchSnapshot();
  });
});

// 各ケースは公開 .d.ts を in-memory で emit する（ts.createProgram＝lib 読込込みのコールドコスト大）。
// 既定 5s では全体スイート同時実行の負荷下で稀に timeout するため、明示 timeout を与える（DD-017）。
// emit は 1 program に束ねてモジュール内共有するため、実コストを払うのは最初の 1 ケースのみ（DD-028）。
const DTS_EMIT_TIMEOUT_MS = 60_000;

describe('contract: Facade 公開 .d.ts snapshot（型シグネチャ全文・DD-028 S2-3）', () => {
  it(
    '@nanairo-sheet/grid の公開宣言 closure',
    () => {
      expect(publicDeclarationClosure(FACADE_DIRS.grid)).toMatchSnapshot();
    },
    DTS_EMIT_TIMEOUT_MS,
  );

  it(
    '@nanairo-sheet/server-hono の公開宣言 closure',
    () => {
      expect(publicDeclarationClosure(FACADE_DIRS.serverHono)).toMatchSnapshot();
    },
    DTS_EMIT_TIMEOUT_MS,
  );

  it(
    '@nanairo-sheet/react の公開宣言 closure',
    () => {
      expect(publicDeclarationClosure(FACADE_DIRS.react)).toMatchSnapshot();
    },
    DTS_EMIT_TIMEOUT_MS,
  );
});

describe('contract: R7 内部型漏洩0（公開宣言 closure に内部パッケージ型が現れない）', () => {
  it(
    '@nanairo-sheet/grid の公開宣言は内部パッケージ型を漏らさない',
    () => {
      const dts = publicDeclarationClosure(FACADE_DIRS.grid);
      expect(dts.length).toBeGreaterThan(0);
      expect(dts).not.toMatch(INTERNAL_PACKAGE_RE);
    },
    DTS_EMIT_TIMEOUT_MS,
  );

  it(
    '@nanairo-sheet/server-hono の公開宣言は内部パッケージ型を漏らさない',
    () => {
      const dts = publicDeclarationClosure(FACADE_DIRS.serverHono);
      expect(dts.length).toBeGreaterThan(0);
      expect(dts).not.toMatch(INTERNAL_PACKAGE_RE);
    },
    DTS_EMIT_TIMEOUT_MS,
  );

  it(
    '@nanairo-sheet/react の公開宣言は内部パッケージ型を漏らさない（grid 参照は Facade 公開型のため正当）',
    () => {
      const dts = publicDeclarationClosure(FACADE_DIRS.react);
      expect(dts.length).toBeGreaterThan(0);
      expect(dts).not.toMatch(INTERNAL_PACKAGE_RE);
    },
    DTS_EMIT_TIMEOUT_MS,
  );
});
