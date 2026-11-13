import { Injectable } from '@nestjs/common';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { Subject } from 'rxjs';
import { dataDirectory } from '../../core/config';

@Injectable()
export class TaskLogService {
  readonly changes = new Subject<{ taskId: string }>();
  private readonly dataDir = dataDirectory;
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
    if (!key) return { content: '', nextOffset: 0 };
    const file = this.path(key);
    if (!existsSync(file)) return { content: '', nextOffset: 0 };
    const size = statSync(file).size;
    const start = Math.max(0, Math.min(size, Math.floor(offset)));
    const buffer = Buffer.alloc(Math.min(size - start, 256 * 1024));
    const fd = openSync(file, 'r');
    let bytes: number;
    try {
      bytes = readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    // End chunks at a UTF-8 boundary so offset based continuation is lossless.
    let end = bytes;
    if (start + bytes < size && end > 0) {
      let lead = end - 1;
      while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
      const first = buffer[lead]!;
      const expected =
        first < 0x80 ? 1 : (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : 4;
      if (end - lead < expected) end = lead;
    }
    return { content: buffer.subarray(0, end).toString('utf8'), nextOffset: start + end };
  }
}
