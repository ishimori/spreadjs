// versioned persisted snapshot（DD-014・CG-3）。既存 SnapshotData v3（snapshot.ts）を土台に、永続化封筒
// （format version・documentId・確定 revision・createdAt・checksum）を付与した **persisted snapshot format v1** を定義する。
//
// 位置づけ（要確認③確定）: **log＝正本・snapshot＝復元最適化物**。ゆえに persisted snapshot は operationLog を埋め込まない
// （＝サイズ O(document)。埋め込むと snapshot 生成ごとに O(N) 書込＝総 O(N²) の write amplification を招く）。復元は
// snapshot（document@R）＋ oplog tail（revision>R）で行う。整合は checksum（改竄/bit-rot 検知）＋ 既存 v3 fail-fast で守る。
//
// fail-fast（AC6）: format version 不一致・checksum 不一致・JSON 破損・v3 fail-fast（version 不一致/重複 slot/孤児セル）を
// すべて throw する（黙って空文書・部分文書にしない）。

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord } from '@nanairo-sheet/core';

import type { SnapshotData } from './snapshot';

/**
 * persisted snapshot 封筒の版数。SnapshotData（中身）は v3。封筒 format と中身 version は独立に検査する。
 * v2（DD-026-1）: checksum の正準化を**深いキー順ソート**へ変更した。v1 は挿入順 `JSON.stringify` だったため、
 * キー順を保持しない保存先（Postgres jsonb 等・consumer 注入ストア）に置くと再起動時に必ず checksum 不一致で
 * fail-fast していた。v1 ファイルは旧算法で検証して読める（書込は常に v2）。
 */
export const SNAPSHOT_FORMAT_VERSION = 2 as const;
/** 読込互換のみ（DD-014 で書かれた既存 dev 永続化ディレクトリを壊さない）。 */
export const LEGACY_SNAPSHOT_FORMAT_VERSION = 1 as const;

/** 永続化 snapshot（封筒）。checksum は自身を除く payload の canonical JSON に対する sha256。 */
export interface PersistedSnapshot {
  formatVersion: typeof SNAPSHOT_FORMAT_VERSION | typeof LEGACY_SNAPSHOT_FORMAT_VERSION;
  documentId: string;
  revision: number; // この snapshot が表す確定 revision R（document は R 時点）
  createdAt: string; // ISO（監査用・非 checksum 対象外＝checksum 対象に含める）
  snapshot: SnapshotData; // v3 payload（operationLog は空＝log は別 oplog が正本）
  checksum: string; // sha256(canonical payload without checksum)
}

/** persisted snapshot ストア。save は atomic（temp→fsync→rename）。loadLatest は最新 revision を検証付きで読む。 */
export interface SnapshotStore {
  save(persisted: PersistedSnapshot): Promise<void>;
  /** 最新（最大 revision）の有効 snapshot を返す。存在しなければ undefined。破損なら throw（fail-fast・AC6）。 */
  loadLatest(): Promise<PersistedSnapshot | undefined>;
  close(): Promise<void>;
}

/**
 * payload（checksum を除く）を canonical JSON 化する（決定的 checksum の源）。
 * - v2: 全階層のオブジェクトキーを昇順に並べる（配列順は保持）。JSON として同値なら保存先のキー順によらず一致する。
 * - v1（読込互換）: 封筒 5 項目を固定順に置いた `JSON.stringify`（中身の snapshot は挿入順のまま）。
 */
function canonicalPayload(p: Omit<PersistedSnapshot, 'checksum'>): string {
  const ordered = {
    formatVersion: p.formatVersion,
    documentId: p.documentId,
    revision: p.revision,
    createdAt: p.createdAt,
    snapshot: p.snapshot,
  };
  return p.formatVersion === LEGACY_SNAPSHOT_FORMAT_VERSION ? JSON.stringify(ordered) : canonicalJson(ordered);
}

/** JSON 同値なら同一文字列になる正準直列化（オブジェクトキー昇順・undefined 値は JSON.stringify と同じく省略）。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (isRecord(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) {
        parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
      }
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SnapshotData（＋メタ）を persisted snapshot 封筒へ包む（checksum を計算して封入する）。 */
export function createPersistedSnapshot(input: {
  documentId: string;
  revision: number;
  createdAt: string;
  snapshot: SnapshotData;
}): PersistedSnapshot {
  const payload: Omit<PersistedSnapshot, 'checksum'> = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    documentId: input.documentId,
    revision: input.revision,
    createdAt: input.createdAt,
    snapshot: input.snapshot,
  };
  return { ...payload, checksum: sha256(canonicalPayload(payload)) };
}

/**
 * JSON 文字列を PersistedSnapshot として検証付きで読む（format version・checksum を fail-fast 検査）。
 * v2 は正準化済みゆえキー順が入れ替わっていても検証できる（consumer 注入ストア経由の往復・DD-026-1）。v1 は旧算法で検証する。
 */
export function parsePersistedSnapshot(text: string): PersistedSnapshot {
  const parsed = JSON.parse(text) as PersistedSnapshot; // JSON 破損はここで throw（fail-fast）
  if (parsed.formatVersion !== SNAPSHOT_FORMAT_VERSION && parsed.formatVersion !== LEGACY_SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `parsePersistedSnapshot: 非対応の format version ${String(parsed.formatVersion)}（対応=${SNAPSHOT_FORMAT_VERSION}・読込互換=${LEGACY_SNAPSHOT_FORMAT_VERSION}）`,
    );
  }
  const expected = sha256(
    canonicalPayload({
      formatVersion: parsed.formatVersion,
      documentId: parsed.documentId,
      revision: parsed.revision,
      createdAt: parsed.createdAt,
      snapshot: parsed.snapshot,
    }),
  );
  if (parsed.checksum !== expected) {
    throw new Error(
      `parsePersistedSnapshot: checksum 不一致（破損の疑い・revision ${String(parsed.revision)}）`,
    );
  }
  return parsed;
}

const SNAPSHOT_PREFIX = 'snapshot-';
const SNAPSHOT_SUFFIX = '.json';

/** ファイルベース persisted snapshot ストア。ファイル名 `snapshot-{revision}.json`（revision で世代を識別）。 */
export class FileSnapshotStore implements SnapshotStore {
  constructor(
    private readonly dir: string,
    private readonly keepGenerations = 2, // 直近 K 世代を保持（要確認③確定 K=2）
  ) {}

  async save(persisted: PersistedSnapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const finalPath = join(this.dir, `${SNAPSHOT_PREFIX}${persisted.revision}${SNAPSHOT_SUFFIX}`);
    const tempPath = `${finalPath}.tmp`;
    // temp へ write＋fsync してから atomic rename（rename 前クラッシュでも旧世代が loadLatest 対象で残る＝部分 snapshot を見せない）。
    const handle = await open(tempPath, 'w');
    try {
      await writeAllBytes(handle, JSON.stringify(persisted)); // short write を許さず全バイト書き切る（Codex P1-2）
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, finalPath);
    await this.prune();
  }

  async loadLatest(): Promise<PersistedSnapshot | undefined> {
    const revisions = await this.listRevisions();
    if (revisions.length === 0) {
      return undefined;
    }
    const latest = revisions[revisions.length - 1];
    const text = await readFile(join(this.dir, `${SNAPSHOT_PREFIX}${latest}${SNAPSHOT_SUFFIX}`), 'utf8');
    // 最新世代が破損していれば throw（fail-fast・AC6）。atomic save により final 名は常に完全＝破損は bit-rot/改竄のみ。
    return parsePersistedSnapshot(text);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** 保持世代を超えた古い snapshot を削除する（revision 昇順で古い方から）。 */
  private async prune(): Promise<void> {
    const revisions = await this.listRevisions();
    const excess = revisions.length - this.keepGenerations;
    for (let i = 0; i < excess; i += 1) {
      await unlink(join(this.dir, `${SNAPSHOT_PREFIX}${revisions[i]}${SNAPSHOT_SUFFIX}`));
    }
  }

  /** snapshot ファイルの revision 一覧を昇順で返す。 */
  private async listRevisions(): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
    const revisions: number[] = [];
    for (const name of names) {
      if (name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX)) {
        const middle = name.slice(SNAPSHOT_PREFIX.length, name.length - SNAPSHOT_SUFFIX.length);
        const revision = Number(middle);
        if (Number.isInteger(revision) && revision >= 0) {
          revisions.push(revision);
        }
      }
    }
    return revisions.sort((a, b) => a - b);
  }
}

/** テスト用インメモリ snapshot ストア。 */
export class MemorySnapshotStore implements SnapshotStore {
  private latest: PersistedSnapshot | undefined;
  saveCount = 0;

  save(persisted: PersistedSnapshot): Promise<void> {
    // 実 store と同じく往復（parse 検証）を通す＝checksum/round-trip を単体でも守る。
    this.latest = parsePersistedSnapshot(JSON.stringify(persisted));
    this.saveCount += 1;
    return Promise.resolve();
  }

  loadLatest(): Promise<PersistedSnapshot | undefined> {
    return Promise.resolve(this.latest);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** short write を許さず全バイトを書き切る（FileHandle.write は途中書きを返し得る・Codex P1-2）。 */
async function writeAllBytes(handle: FileHandle, data: string): Promise<void> {
  const buffer = Buffer.from(data, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) {
      throw new Error('FileSnapshotStore: write made no progress (short write)');
    }
    offset += bytesWritten;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
