import { Injectable } from '@nestjs/common';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { Subject } from 'rxjs';
import type { Kysely } from 'kysely';
import { dataDirectory } from '../../core/config';
import type { Database } from '../../core/database/schema';
import {
  missingLogFile,
  pruneTaskLogs,
  type LogRetentionPolicies,
  type LogRetentionResult,
} from './task-log-retention';

@Injectable()
export class TaskLogService {
  readonly changes = new Subject<{ taskId: string }>();
  private readonly dataDir = dataDirectory;
  private retentionCursor?: { policy: string; id: string };

  async pruneExpired(
    database: Kysely<Database>,
    policy: number | LogRetentionPolicies,
    now = Date.now(),
    reread?: (database: Kysely<Database>) => Promise<LogRetentionPolicies>,
  ): Promise<LogRetentionResult> {
    if (!Number.isSafeInteger(now)) {
      this.retentionCursor = undefined;
      return { removed: 0, missing: 0, skipped: 0, failed: 0, more: false };
    }
    const policies =
      typeof policy === 'number'
        ? { systemDays: policy, projectDays: new Map<string, number>() }
        : policy;
    const signature = JSON.stringify([
      policies.systemDays,
      Array.from(policies.projectDays).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    const current =
      this.retentionCursor?.policy === signature ? this.retentionCursor.id : undefined;
    const { result, nextCursor } = await pruneTaskLogs(
      database,
      this.dataDir,
      policies,
      now,
      current,
      (id, createdAt) => this.key(id, createdAt),
      reread,
    );
    this.retentionCursor = nextCursor ? { policy: signature, id: nextCursor } : undefined;
    return result;
  }
  key(taskId: string, at: number): string {
    const date = new Date(at);
    return `logs/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${taskId}.log`;
  }
  path(key: string): string {
    const file = resolve(this.dataDir, key);
    if (relative(this.dataDir, file).startsWith('..')) throw new Error('Invalid log path');
    return file;
  }
  append(taskId: string, key: string, text: string): number {
    const file = this.path(key);
    mkdirSync(dirname(file), { recursive: true });
    // Defense in depth for common credential assignments; SSH output is also stream-redacted.
    const scrubbed = text.replace(
      /((?:password|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*)[^\s]+/gi,
      '$1[REDACTED]',
    );
    appendFileSync(file, scrubbed, { encoding: 'utf8', mode: 0o600 });
    this.changes.next({ taskId });
    return statSync(file).size;
  }
  read(key: string | null, offset = 0): { content: string; nextOffset: number } {
    return this.readChunk(key, () => offset) ?? { content: '', nextOffset: offset };
  }
  private readChunk(key: string | null, position: (size: number) => number) {
    if (!key) return undefined;
    let fd: number;
    try {
      fd = openSync(this.path(key), 'r');
    } catch (error) {
      if (missingLogFile(error)) return undefined;
      throw error;
    }
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, Math.min(size, Math.floor(position(size))));
      const buffer = Buffer.alloc(Math.min(size - start, 256 * 1024));
      const bytes = readSync(fd, buffer, 0, buffer.length, start);
      let end = bytes;
      // End chunks at a UTF-8 boundary so offset based continuation is lossless.
      if (start + bytes < size && end > 0) {
        let lead = end - 1;
        while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
        const first = buffer[lead]!;
        const expected =
          first < 0x80 ? 1 : (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : 4;
        if (end - lead < expected) end = lead;
      }
      return { content: buffer.subarray(0, end).toString('utf8'), nextOffset: start + end };
    } finally {
      closeSync(fd);
    }
  }
  tail(key: string | null): string {
    return this.readChunk(key, (size) => Math.max(0, size - 64 * 1024))?.content ?? '';
  }
}
