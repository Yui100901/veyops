import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';

export interface AiWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AiToolCall[];
  tool_call_id?: string;
}
export interface AiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface AiWireResponse {
  content: string | null;
  tool_calls?: AiToolCall[];
}
export interface AiConnection {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutSeconds: number;
}

export function completionUrl(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new BadRequestException('AI Base URL 无效');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new BadRequestException('AI Base URL 必须使用 HTTPS；本机测试可使用 HTTP');
  if (url.username || url.password || url.search || url.hash)
    throw new BadRequestException('AI Base URL 不得包含凭据、查询参数或片段');
  return url.toString().replace(/\/+$/, '') + '/chat/completions';
}
export function sanitizeAiText(text: string, secrets: string[] = []): string {
  let output = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    output = output.split(secret).join('[REDACTED]');
  return output
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|password|access[_-]?token|api[_-]?secret)\s*[=:]\s*)[^\s,;"'}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
@Injectable()
export class OpenAiCompatibleService {
  async complete(
    connection: AiConnection,
    messages: AiWireMessage[],
    tools: unknown[] = [],
  ): Promise<AiWireResponse> {
    const endpoint = completionUrl(connection.baseUrl);
    const maxBytes = 2 * 1024 * 1024;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(connection.timeoutSeconds * 1000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify({
          model: connection.model,
          messages,
          stream: false,
          max_tokens: 4096,
          ...(new URL(connection.baseUrl).hostname === 'api.deepseek.com'
            ? { thinking: { type: 'disabled' } }
            : {}),
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BadGatewayException(
          `AI 服务请求失败（HTTP ${response.status}），请检查模型、额度及配置`,
        );
      }
      if (Number(response.headers.get('content-length') || 0) > maxBytes) {
        await response.body?.cancel();
        throw new BadGatewayException('AI 响应超过大小限制');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new BadGatewayException('AI 服务返回空响应');
      const parts: Uint8Array[] = [];
      let count = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.length;
        if (count > maxBytes) {
          await reader.cancel();
          throw new BadGatewayException('AI 响应超过大小限制');
        }
        parts.push(value);
      }
      const json = JSON.parse(Buffer.concat(parts).toString('utf8')) as {
        choices?: { message?: AiWireResponse }[];
      };
      const message = json.choices?.[0]?.message;
      if (
        !message ||
        (typeof message.content !== 'string' &&
          message.content !== null &&
          !Array.isArray(message.tool_calls))
      )
        throw new BadGatewayException('AI 响应不符合 OpenAI 兼容格式');
      if (
        message.tool_calls &&
        (!Array.isArray(message.tool_calls) ||
          message.tool_calls.length > 8 ||
          message.tool_calls.some(
            (tool) =>
              !tool?.id ||
              tool.type !== 'function' ||
              typeof tool.function?.name !== 'string' ||
              typeof tool.function.arguments !== 'string' ||
              tool.function.arguments.length > 65536,
          ))
      )
        throw new BadGatewayException('AI 工具调用格式无效或超过限制');
      // Do not expose or persist provider-specific reasoning fields.
      return {
        content:
          typeof message.content === 'string'
            ? sanitizeAiText(message.content, [connection.apiKey])
            : null,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      };
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof BadRequestException) throw error;
      throw new BadGatewayException('AI 服务连接失败或超时，请检查配置后重试');
    }
  }
}
