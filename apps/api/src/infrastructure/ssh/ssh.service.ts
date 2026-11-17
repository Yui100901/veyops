import { Injectable } from '@nestjs/common';
import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { CredentialsService } from '../../modules/credentials/credentials.service';
import { redactText, SecretRedactor } from './secret-redactor';
import { serverProbeCommand } from './server-probe';
import type { SFTPWrapper } from 'ssh2';

export interface SshTarget {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  credentialId: string | null;
  hostKeyFingerprint: string | null;
  credentialNonce?: string;
}
export interface SshOptions {
  timeout: number;
  signal?: AbortSignal;
  onData?: (text: string, stream: 'stdout' | 'stderr') => void;
  secrets?: string[];
}
export class SshExecutionError extends Error {
  constructor(
    message: string,
    public readonly kind: 'FAILED' | 'TIMED_OUT' | 'CANCELLED' | 'NEEDS_ATTENTION' = 'FAILED',
  ) {
    super(message);
  }
}

export class SshHostKeyMismatchError extends SshExecutionError {
  constructor(kind: 'FAILED' | 'NEEDS_ATTENTION' = 'FAILED') {
    super('SSH 主机指纹与已确认值不一致，连接已中止', kind);
  }
}

export interface SshHostKey {
  algorithm: string;
  fingerprint: string;
}

export function fingerprintMatches(rawKey: Buffer, expected: string): boolean {
  const digest = createHash('sha256').update(rawKey).digest();
  const normalized = expected.trim();
  const actual = normalized.startsWith('SHA256:')
    ? digest.toString('base64').replace(/=+$/, '')
    : digest.toString('hex');
  const wanted = normalized.startsWith('SHA256:')
    ? normalized.slice(7).replace(/=+$/, '')
    : normalized.toLowerCase();
  return (
    actual.length === wanted.length && timingSafeEqual(Buffer.from(actual), Buffer.from(wanted))
  );
}

@Injectable()
export class SshService {
  constructor(private readonly credentials: CredentialsService) {}

  async inspectHostKey(endpoint: Pick<SshTarget, 'host' | 'port'>): Promise<SshHostKey> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let observed: SshHostKey | undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.destroy();
        if (observed) resolve(observed);
        else reject(new SshExecutionError('未能读取 SSH 主机指纹，请检查连接地址、端口和网络'));
      };
      const timer = setTimeout(finish, 8_000);
      client.on('error', finish);
      client.once('close', finish);
      try {
        client.connect({
          ...endpoint,
          username: 'host-key-probe',
          readyTimeout: 8_000,
          hostVerifier: (key: Buffer) => {
            // The host key type is the first SSH string in the public-key blob.
            if (key.length < 4) return false;
            const length = key.readUInt32BE(0);
            if (!length || length > 128 || length > key.length - 4) return false;
            const algorithm = key.subarray(4, length + 4).toString('latin1');
            if (/^[\w@.+-]+$/.test(algorithm)) {
              observed = {
                algorithm,
                fingerprint: `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`,
              };
            }
            // Stop key exchange before user authentication. This probe has no credential.
            return false;
          },
        });
      } catch {
        finish();
      }
    });
  }

  async execute(
    target: SshTarget,
    command: string,
    options: SshOptions,
  ): Promise<{ exitCode: number; signal?: string }> {
    if (!target.hostKeyFingerprint)
      throw new SshExecutionError('服务器尚未配置已确认的 SSH SHA256 主机指纹');
    if (options.signal?.aborted) throw new SshExecutionError('任务已取消', 'CANCELLED');
    if (!target.credentialId) throw new SshExecutionError('服务器尚未关联 SSH 凭据');
    const secret = await this.credentials.decrypt(target.credentialId, target.credentialNonce);
    if (options.signal?.aborted) throw new SshExecutionError('任务已取消', 'CANCELLED');
    const secretValues = [...Object.values(secret), ...(options.secrets || [])];
    return new Promise((resolve, reject) => {
      const client = new Client();
      let channel: ClientChannel | undefined;
      let settled = false;
      let hostKeyRejected = false;
      let outputBytes = 0;
      const outputLimit = 5 * 1024 * 1024;
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      const redactors = {
        stdout: new SecretRedactor(secretValues),
        stderr: new SecretRedactor(secretValues),
      };
      const emit = (data: Buffer, stream: 'stdout' | 'stderr') => {
        outputBytes += data.length;
        if (outputBytes > outputLimit) {
          finish(
            new SshExecutionError(
              '输出超过 5 MiB 限制，已终止连接；请核查远程执行状态',
              'NEEDS_ATTENTION',
            ),
          );
          return;
        }
        const text = redactors[stream].write(decoders[stream].write(data));
        try {
          if (text) options.onData?.(text, stream);
        } catch {
          finish(
            new SshExecutionError('任务日志写入失败，远程执行结果需要核查', 'NEEDS_ATTENTION'),
          );
        }
      };
      const flush = (): Error | undefined => {
        for (const stream of ['stdout', 'stderr'] as const) {
          const text = redactors[stream].write(decoders[stream].end()) + redactors[stream].end();
          try {
            if (text) options.onData?.(text, stream);
          } catch {
            return new SshExecutionError(
              '任务日志写入失败，远程执行结果需要核查',
              'NEEDS_ATTENTION',
            );
          }
        }
        return undefined;
      };
      const finish = (error?: Error, result?: { exitCode: number; signal?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        const finalError = error ?? flush();
        if (error) flush();
        if (finalError && channel) {
          try {
            channel.signal('TERM');
          } catch {
            /* already closed */
          }
        }
        channel?.close();
        client.end();
        if (finalError) reject(finalError);
        else resolve(result ?? { exitCode: 0 });
      };
      const cancel = () =>
        finish(new SshExecutionError('任务取消；远程进程可能需要人工确认已停止', 'CANCELLED'));
      const timer = setTimeout(
        () => finish(new SshExecutionError('SSH 命令执行超时；请检查远程进程状态', 'TIMED_OUT')),
        options.timeout * 1000,
      );
      options.signal?.addEventListener('abort', cancel, { once: true });
      const config: ConnectConfig = {
        host: target.host,
        port: target.port,
        username: target.username,
        readyTimeout: Math.min(options.timeout * 1000, 15_000),
        hostVerifier: (key: Buffer) => {
          hostKeyRejected = !fingerprintMatches(key, target.hostKeyFingerprint!);
          return !hostKeyRejected;
        },
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
      };
      if (secret.privateKey) {
        config.privateKey = secret.privateKey;
        config.passphrase = secret.passphrase;
      } else if (secret.password) config.password = secret.password;
      else {
        finish(new SshExecutionError('所选凭据不包含 SSH 密码或私钥'));
        return;
      }
      client.on('ready', () => {
        if (settled) {
          client.end();
          return;
        }
        client.exec(command, (error, stream) => {
          if (error) {
            finish(new SshExecutionError(redactText(error.message, secretValues)));
            return;
          }
          if (settled) {
            stream.close();
            return;
          }
          channel = stream;
          stream.on('data', (data: Buffer) => emit(data, 'stdout'));
          stream.stderr.on('data', (data: Buffer) => emit(data, 'stderr'));
          stream.on('error', (err: Error) =>
            finish(new SshExecutionError(redactText(err.message, secretValues), 'NEEDS_ATTENTION')),
          );
          stream.on('close', (code: number | null, signal?: string) => {
            if (typeof code === 'number' || signal)
              finish(undefined, { exitCode: code ?? 128, signal });
            else
              finish(
                new SshExecutionError(
                  'SSH 未返回命令退出状态，远程执行结果未知',
                  'NEEDS_ATTENTION',
                ),
              );
          });
        });
      });
      client.on('error', (error: Error) =>
        finish(
          hostKeyRejected
            ? new SshHostKeyMismatchError(channel ? 'NEEDS_ATTENTION' : 'FAILED')
            : new SshExecutionError(
                redactText(error.message, secretValues),
                channel ? 'NEEDS_ATTENTION' : 'FAILED',
              ),
        ),
      );
      client.on('close', () => {
        if (!settled)
          finish(
            hostKeyRejected
              ? new SshHostKeyMismatchError(channel ? 'NEEDS_ATTENTION' : 'FAILED')
              : new SshExecutionError(
                  'SSH 连接意外断开，远程执行结果未知',
                  channel ? 'NEEDS_ATTENTION' : 'FAILED',
                ),
          );
      });
      try {
        client.connect(config);
      } catch (error) {
        finish(new SshExecutionError(redactText((error as Error).message, secretValues)));
      }
    });
  }

  async upload(
    target: SshTarget,
    localPath: string,
    remotePath: string,
    options: SshOptions,
  ): Promise<void> {
    await this.transfer(
      target,
      options,
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          sftp.fastPut(localPath, remotePath, { mode: 0o600 }, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
  }

  async uploadContent(
    target: SshTarget,
    content: string | Buffer,
    remotePath: string,
    options: SshOptions & { mode?: number },
  ): Promise<void> {
    await this.transfer(
      target,
      options,
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          sftp.writeFile(remotePath, content, { mode: options.mode ?? 0o600 }, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
  }

  async download(
    target: SshTarget,
    remotePath: string,
    localPath: string,
    options: SshOptions,
  ): Promise<void> {
    await this.transfer(
      target,
      options,
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()));
        }),
    );
  }

  private async transfer(
    target: SshTarget,
    options: SshOptions,
    operation: (sftp: SFTPWrapper) => Promise<void>,
  ): Promise<void> {
    if (!target.credentialId || !target.hostKeyFingerprint)
      throw new SshExecutionError('SFTP 需要 SSH 凭据和已确认的主机指纹');
    if (options.signal?.aborted) throw new SshExecutionError('传输已取消', 'CANCELLED');
    const secret = await this.credentials.decrypt(target.credentialId, target.credentialNonce);
    if (options.signal?.aborted) throw new SshExecutionError('传输已取消', 'CANCELLED');
    return new Promise<void>((resolve, reject) => {
      const client = new Client();
      let sftp: SFTPWrapper | undefined;
      let settled = false;
      let hostKeyRejected = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        sftp?.end();
        client.end();
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new SshExecutionError('SFTP 传输已取消', 'CANCELLED'));
      const timer = setTimeout(
        () => finish(new SshExecutionError('SFTP 传输超时', 'TIMED_OUT')),
        options.timeout * 1000,
      );
      options.signal?.addEventListener('abort', abort, { once: true });
      client.on('ready', () =>
        client.sftp((error, channel) => {
          if (settled) {
            channel?.end();
            return;
          }
          if (error) {
            finish(new SshExecutionError('SFTP 子系统启动失败'));
            return;
          }
          sftp = channel;
          void operation(channel).then(
            () => finish(),
            () => finish(new SshExecutionError('SFTP 文件传输失败，请检查路径和权限')),
          );
        }),
      );
      client.on('error', () =>
        finish(
          hostKeyRejected
            ? new SshHostKeyMismatchError(sftp ? 'NEEDS_ATTENTION' : 'FAILED')
            : new SshExecutionError('SFTP 连接失败，请检查主机指纹和凭据'),
        ),
      );
      client.on('close', () => {
        if (!settled)
          finish(
            hostKeyRejected
              ? new SshHostKeyMismatchError(sftp ? 'NEEDS_ATTENTION' : 'FAILED')
              : new SshExecutionError('SFTP 连接意外中断'),
          );
      });
      try {
        client.connect({
          host: target.host,
          port: target.port,
          username: target.username,
          readyTimeout: Math.min(options.timeout * 1000, 15000),
          hostVerifier: (key: Buffer) => {
            hostKeyRejected = !fingerprintMatches(key, target.hostKeyFingerprint!);
            return !hostKeyRejected;
          },
          ...(secret.privateKey
            ? { privateKey: secret.privateKey, passphrase: secret.passphrase }
            : { password: secret.password }),
        });
      } catch {
        finish(new SshExecutionError('SFTP 连接启动失败'));
      }
    });
  }

  async probe(target: SshTarget): Promise<{ exitCode: number; output: string }> {
    let output = '';
    const result = await this.execute(target, serverProbeCommand, {
      timeout: 15,
      onData: (text, stream) => {
        if (stream === 'stdout' && output.length < 8192)
          output += text.slice(0, 8192 - output.length);
      },
    });
    return { ...result, output };
  }
}
