// append-only operation log の永続化（DD-014・CG-3）。operation log は「正本」（ADR-0005 server-ordered log）で、
// snapshot は復元最適化物。durable ACK 契約（要確認②確定）: **fsync 完了後に ACK**＝「ACK 受領＝再起動後も失われない」。
// 実装は group commit（同一 tick 内の append を 1 回の write+fsync へまとめる小バッチ）を許容する。
//
// 設計方針:
//   - packages/server は「注入クロックで決定的」の哲学を保つ（Sequencer/Room は Node API 非参照）。本ファイルは
//     **永続化アダプター**（Phase 4 collaboration-server が配線）ゆえ node:fs/promises を使う唯一の store 層。
//   - 障害モデル（§6 トラステッド環境）: fsync が OS/ディスクのキャッシュまで通す前提（bit-rot・電源喪失時のディスク
//     キャッシュ honesty は非保証・durability-contract.md 参照）。
//   - torn write（クラッシュで末尾レコードが途中書き）: 末尾行に改行が無い＝未 fsync＝未 ACK ゆえ安全に破棄（uncommitted）。
//     中間行の破損は既 ACK 済みデータの破損ゆえ fail-fast（AC6）。

import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ServerOperationEnvelope } from '@nanairo-sheet/core';

/** oplog 読み出し結果。`discardedTornRecords`>0 は末尾の未 ACK 途中書きを破棄したことを表す（黙って捨てず報告）。 */
export interface OpLogReadResult {
  entries: ServerOperationEnvelope[];
  discardedTornRecords: number;
}

/**
 * append-only operation log ストア。`append` は解決した時点で **durable**（fsync 済み）であることを契約とする。
 * ファイル実装（FileOpLogStore）とテスト用インメモリ実装（MemoryOpLogStore）が満たす。
 */
export interface OpLogStore {
  /** accepted envelope 群を追記する。解決時に fsync 済み（durable ACK 境界）。順序は呼び出し順で保存される。 */
  append(entries: readonly ServerOperationEnvelope[]): Promise<void>;
  /** 全 operation を読み出す（再起動復旧用）。末尾の torn write は破棄し件数を報告、中間破損は throw（fail-fast）。 */
  readAll(): Promise<OpLogReadResult>;
  /** ハンドルを閉じる（保留中の flush を待ってから）。 */
  close(): Promise<void>;
}

interface QueueItem {
  data: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * ファイルベース append-only JSONL operation log。1 operation = 1 行（JSON＋'\n'）。
 * group commit: 同一の flush ループ内に積まれた append を 1 回の write+fsync でまとめて durable 化する。
 */
export class FileOpLogStore implements OpLogStore {
  private readonly queue: QueueItem[] = [];
  private handle: FileHandle | undefined;
  private flushing = false;
  private flushPromise: Promise<void> = Promise.resolve();
  private closed = false;
  private failed: unknown; // fsync 失敗後は fail-stop（以降の append を全 reject・DD-014-1 P1-A: revision 欠番防止）

  constructor(private readonly path: string) {}

  append(entries: readonly ServerOperationEnvelope[]): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('FileOpLogStore: closed'));
    }
    // fail-stop（P1-A）: 一度でも fsync に失敗したら以降の append は全て reject する。並行 in-flight で先行 append が
    // 失敗した後に後続 append が成功して revision を書き進め、oplog に欠番/偽 durable ACK が生じるのを防ぐ。
    if (this.failed !== undefined) {
      return Promise.reject(
        new Error(`FileOpLogStore: fail-stop（先行 append の durable 書込が失敗済み）: ${errorMessage(this.failed)}`),
      );
    }
    // JSON 直列化は enqueue 時点で同期的に行う（呼び出し順＝revision 順を保存する）。
    const data = entries.map((e) => `${JSON.stringify(e)}\n`).join('');
    if (data.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ data, resolve, reject });
      this.scheduleFlush();
    });
  }

  /**
   * append 用ハンドルを開く（初回のみ）。親ディレクトリを再帰作成し（Codex P2-2）、
   * 既存ファイル末尾に改行なしの torn tail（クラッシュで途中書きされた未 fsync レコード）が残っていれば
   * 最後の改行位置まで物理 truncate してから開く（Codex P1-1）。これで再開後の append が破損バイトへ連結せず、
   * ACK 済みレコードが後続破損の巻き添えにならない。
   */
  private async ensureOpen(): Promise<void> {
    if (this.handle !== undefined) {
      return;
    }
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const buf = await readFile(this.path);
      if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
        const lastNewline = buf.lastIndexOf(0x0a); // -1 → truncate to 0（全体が未完了レコード）
        await truncate(this.path, lastNewline + 1);
      }
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
    this.handle = await open(this.path, 'a'); // append モード（既存ログの末尾へ）
  }

  private scheduleFlush(): void {
    if (this.flushing) {
      return; // 進行中の flush ループが while で新規分も拾う（group commit）
    }
    this.flushing = true;
    this.flushPromise = this.flush();
  }

  private async flush(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0); // このバッチをまとめて 1 write+fsync（group commit）
        try {
          await this.ensureOpen();
          const data = batch.map((b) => b.data).join('');
          await writeAllBytes(this.handle!, data); // short write を許さず全バイト書き切る（DD-014 Codex P1-2）
          await this.handle!.sync(); // fsync = durable 境界。ここを過ぎたバッチは再起動後も残る。
          for (const item of batch) {
            item.resolve();
          }
        } catch (error) {
          // fail-stop（P1-A）: 失敗バッチを reject し、以降 enqueue 済み/新規の append を全 reject する
          // （後続 append が成功して revision を書き進める＝欠番/偽 durable を防ぐ）。
          this.failed = error;
          for (const item of batch) {
            item.reject(error);
          }
          for (const item of this.queue.splice(0)) {
            item.reject(error);
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async readAll(): Promise<OpLogReadResult> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isEnoent(error)) {
        return { entries: [], discardedTornRecords: 0 };
      }
      throw error;
    }
    if (text.length === 0) {
      return { entries: [], discardedTornRecords: 0 };
    }
    const hasTrailingNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') {
      lines.pop(); // 末尾改行が生む空要素を除去
    }
    const entries: ServerOperationEnvelope[] = [];
    let discardedTornRecords = 0;
    for (const [i, line] of lines.entries()) {
      const isLastLine = i === lines.length - 1;
      if (isLastLine && !hasTrailingNewline) {
        // 末尾の改行なし行＝fsync 未完了の途中書き（未 ACK）。JSON として完全でも改行（commit マーカー）が無い＝
        // 未 durable ゆえ内容によらず破棄し件数を報告する（Codex P1-1・黙って空/誤復元しない）。
        discardedTornRecords += 1;
        continue;
      }
      try {
        entries.push(JSON.parse(line) as ServerOperationEnvelope);
      } catch (error) {
        // 改行付き＝commit 済みレコードの破損＝既 ACK 済みデータの破損。fail-fast（AC6）。
        throw new Error(
          `FileOpLogStore.readAll: oplog corruption at line ${i + 1}: ${errorMessage(error)}`,
        );
      }
    }
    return { entries, discardedTornRecords };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flushPromise;
    if (this.handle !== undefined) {
      await this.handle.close();
      this.handle = undefined;
    }
  }
}

/** テスト用インメモリ oplog（fsync 非現実だが append 順序・readAll 契約は満たす）。torn write 注入も可能。 */
export class MemoryOpLogStore implements OpLogStore {
  private readonly entries: ServerOperationEnvelope[] = [];
  discardedTornRecords = 0;

  append(entries: readonly ServerOperationEnvelope[]): Promise<void> {
    this.entries.push(...entries);
    return Promise.resolve();
  }

  readAll(): Promise<OpLogReadResult> {
    return Promise.resolve({
      entries: this.entries.map((e) => structuredCloneEnvelope(e)),
      discardedTornRecords: this.discardedTornRecords,
    });
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
      throw new Error('FileOpLogStore: write made no progress (short write)');
    }
    offset += bytesWritten;
  }
}

function structuredCloneEnvelope(e: ServerOperationEnvelope): ServerOperationEnvelope {
  return JSON.parse(JSON.stringify(e)) as ServerOperationEnvelope;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
