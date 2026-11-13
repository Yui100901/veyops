import { Global, Injectable, Module } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createGzip } from 'node:zlib';
import { SecretRedactor } from '../ssh/secret-redactor';

export interface ProcessOptions {
  cwd?: string;
  timeout: number;
  signal?: AbortSignal;
  onData?: (text: string, stream: 'stdout' | 'stderr') => void;
  secrets?: string[];
  stdin?: string | Buffer;
  isolatedDocker?: boolean;
  gzipOutput?: { path: string; maxBytes: number };
}
export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    readonly kind: 'FAILED' | 'TIMED_OUT' | 'CANCELLED' = 'FAILED',
  ) {
    super(message);
  }
}

/** Trusted host executables only. Repository scripts must run inside an isolated build container. */
@Injectable()
export class ProcessRunnerService {
  async run(
    command: string,
    args: string[],
    options: ProcessOptions,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (options.signal?.aborted) throw new ProcessExecutionError('构建已取消', 'CANCELLED');
    if (!Number.isFinite(options.timeout) || options.timeout < 1 || options.timeout > 7200)
      throw new ProcessExecutionError('无效构建超时');
    if ([command, ...args].some((value) => value.includes('\0')))
      throw new ProcessExecutionError('无效进程参数');
    // Do not pass platform API keys or database configuration to child executables.
    const env: NodeJS.ProcessEnv = {};
    for (const name of [
      'PATH',
      'Path',
      'SystemRoot',
      'COMSPEC',
      'TEMP',
      'TMP',
      'HOME',
      'USERPROFILE',
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
      'DOCKER_TLS_VERIFY',
      'DOCKER_CERT_PATH',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
    ]) {
      if (options.isolatedDocker && name.startsWith('DOCKER_')) continue;
      if (process.env[name]) env[name] = process.env[name];
    }
    if (options.isolatedDocker) env.DOCKER_BUILDKIT = '1';
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let settled = false;
      let bytes = 0;
      let stdout = '';
      let stderr = '';
      let output: Promise<void> | undefined;
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      const redactors = {
        stdout: new SecretRedactor(options.secrets || []),
        stderr: new SecretRedactor(options.secrets || []),
      };
      const emit = (text: string, stream: 'stdout' | 'stderr') => {
        if (!text) return;
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        options.onData?.(text, stream);
      };
      const finish = (error?: Error, code?: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        try {
          for (const stream of ['stdout', 'stderr'] as const)
            emit(redactors[stream].write(decoders[stream].end()) + redactors[stream].end(), stream);
        } catch {
          error = new ProcessExecutionError('构建日志写入失败');
        }
        if (error) {
          child.kill();
          if (output) {
            child.stdout.destroy();
            void output.then(() => reject(error));
          } else reject(error);
        } else resolve({ exitCode: code ?? 1, stdout, stderr });
      };
      const abort = () => finish(new ProcessExecutionError('构建已取消', 'CANCELLED'));
      const timer = setTimeout(
        () => finish(new ProcessExecutionError('构建执行超时', 'TIMED_OUT')),
        options.timeout * 1000,
      );
      const gzipOutput = options.gzipOutput;
      if (gzipOutput) {
        let compressedBytes = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            compressedBytes += chunk.length;
            if (compressedBytes > gzipOutput.maxBytes)
              callback(new ProcessExecutionError('镜像归档超过大小限制'));
            else callback(null, chunk);
          },
        });
        output = pipeline(
          child.stdout,
          createGzip({ level: 1 }),
          limit,
          createWriteStream(gzipOutput.path, { flags: 'wx', mode: 0o600 }),
          { signal: options.signal },
        ).catch((error: unknown) => {
          finish(
            error instanceof ProcessExecutionError
              ? error
              : new ProcessExecutionError('镜像归档写入失败'),
          );
        });
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      for (const stream of ['stdout', 'stderr'] as const)
        if (stream !== 'stdout' || !gzipOutput)
          child[stream].on('data', (data: Buffer) => {
            if (settled) return;
            bytes += data.length;
            if (bytes > 5 * 1024 * 1024) {
              finish(new ProcessExecutionError('构建输出超过 5 MiB 限制'));
              return;
            }
            try {
              emit(redactors[stream].write(decoders[stream].write(data)), stream);
            } catch {
              finish(new ProcessExecutionError('构建日志写入失败'));
            }
          });
      child.on('error', (error: NodeJS.ErrnoException) =>
        finish(
          new ProcessExecutionError(
            command === 'docker' && error.code === 'ENOENT'
              ? '构建运行器启动失败。管理端找不到 Docker CLI，请检查安装及平台进程的 PATH'
              : '构建运行器启动失败，请检查 Docker CLI 和隔离构建环境',
          ),
        ),
      );
      child.on('close', (code) => {
        if (output) void output.then(() => finish(undefined, code));
        else finish(undefined, code);
      });
      child.stdin.on('error', () => {
        /* process may exit before reading input */
      });
      if (options.stdin !== undefined) child.stdin.end(options.stdin);
      else child.stdin.end();
      if (options.signal?.aborted) abort();
    });
  }
}
@Global()
@Module({ providers: [ProcessRunnerService], exports: [ProcessRunnerService] })
export class BuildRunnerModule {}
