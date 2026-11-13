import { Global, Injectable, Module } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { SecretRedactor } from '../ssh/secret-redactor';

export interface ProcessOptions {
  cwd?: string;
  timeout: number;
  signal?: AbortSignal;
  onData?: (text: string, stream: 'stdout' | 'stderr') => void;
  secrets?: string[];
  stdin?: string | Buffer;
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
      if (process.env[name]) env[name] = process.env[name];
    }
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
          reject(error);
        } else resolve({ exitCode: code ?? 1, stdout, stderr });
      };
      const abort = () => finish(new ProcessExecutionError('构建已取消', 'CANCELLED'));
      const timer = setTimeout(
        () => finish(new ProcessExecutionError('构建执行超时', 'TIMED_OUT')),
        options.timeout * 1000,
      );
      options.signal?.addEventListener('abort', abort, { once: true });
      for (const stream of ['stdout', 'stderr'] as const)
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
      child.on('error', () =>
        finish(new ProcessExecutionError('构建运行器启动失败，请检查 Docker CLI 和隔离构建环境')),
      );
      child.on('close', (code) => finish(undefined, code));
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
