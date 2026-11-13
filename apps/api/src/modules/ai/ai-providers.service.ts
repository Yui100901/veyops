import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CredentialsService } from '../credentials/credentials.service';
import { AuditService } from '../audit/audit.service';
import { AiRepository } from './ai.repository';
import { CreateAiProviderDto, UpdateAiProviderDto } from './ai.dto';
import {
  completionUrl,
  OpenAiCompatibleService,
} from '../../infrastructure/ai-provider/openai-compatible.service';

@Injectable()
export class AiProvidersService {
  constructor(
    private readonly repository: AiRepository,
    private readonly credentials: CredentialsService,
    private readonly wire: OpenAiCompatibleService,
    private readonly audit: AuditService,
  ) {}
  async list() {
    return (await this.repository.providers()).map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.base_url,
      model: p.model,
      credentialId: p.credential_id,
      configured: Boolean(p.credential_id),
      timeoutSeconds: p.timeout_seconds,
      enabled: p.enabled === 1,
      createdAt: p.created_at,
    }));
  }
  async create(input: CreateAiProviderDto, userId: string) {
    completionUrl(input.baseUrl);
    const credentialId = await this.credential(input, userId);
    const id = randomUUID();
    await this.repository.createProvider({
      id,
      name: input.name,
      base_url: input.baseUrl.replace(/\/+$/, ''),
      model: input.model,
      credential_id: credentialId,
      timeout_seconds: input.timeoutSeconds ?? 60,
      enabled: input.enabled === false ? 0 : 1,
      created_at: Date.now(),
    });
    await this.audit.record(userId, 'ai.provider.create', 'ai_provider', id);
    return (await this.list()).find((p) => p.id === id)!;
  }
  private async credential(
    input: { apiKey?: string; credentialId?: string; name?: string },
    userId: string,
  ) {
    if (input.apiKey && input.credentialId)
      throw new BadRequestException('API Key 与凭据引用只能选择一种');
    if (input.apiKey)
      return (
        await this.credentials.create(
          {
            name: `AI · ${input.name || 'Provider'}`,
            type: 'API_KEY',
            secret: { apiKey: input.apiKey },
          },
          userId,
        )
      ).id;
    if (input.credentialId) {
      const meta = (await this.credentials.list()).find(
        (c) => c.id === input.credentialId && c.type === 'API_KEY' && c.status === 'ACTIVE',
      );
      if (!meta) throw new BadRequestException('请选择启用的 API_KEY 凭据');
      return input.credentialId;
    }
    return null;
  }
  async update(id: string, input: UpdateAiProviderDto, userId: string) {
    const row = await this.repository.provider(id);
    if (input.baseUrl) completionUrl(input.baseUrl);
    const changedCredential =
      input.apiKey || input.credentialId ? await this.credential(input, userId) : row.credential_id;
    await this.repository.updateProvider(id, {
      name: input.name,
      base_url: input.baseUrl?.replace(/\/+$/, ''),
      model: input.model,
      credential_id: changedCredential,
      timeout_seconds: input.timeoutSeconds,
      enabled: input.enabled === undefined ? undefined : input.enabled ? 1 : 0,
    });
    await this.audit.record(userId, 'ai.provider.update', 'ai_provider', id);
    return (await this.list()).find((p) => p.id === id)!;
  }
  async remove(id: string, userId: string) {
    await this.repository.provider(id);
    await this.repository.deleteProvider(id);
    await this.audit.record(userId, 'ai.provider.delete', 'ai_provider', id);
    return { success: true };
  }
  async resolve(id?: string) {
    const provider = id
      ? await this.repository.provider(id)
      : (await this.repository.providers()).find((p) => p.enabled === 1);
    if (!provider)
      throw new BadRequestException('尚未配置 AI Provider。AI 为可选功能，可在系统设置中添加');
    if (!provider.enabled) throw new BadRequestException('所选 AI Provider 已禁用');
    if (!provider.credential_id) throw new BadRequestException('所选 AI Provider 尚未配置 API Key');
    const secret = await this.credentials.decrypt(provider.credential_id);
    if (!secret.apiKey) throw new BadRequestException('AI Provider 凭据不包含 API Key');
    return {
      id: provider.id,
      baseUrl: provider.base_url,
      model: provider.model,
      timeoutSeconds: provider.timeout_seconds,
      apiKey: secret.apiKey,
    };
  }
  async test(id: string, userId: string) {
    const c = await this.resolve(id);
    const result = await this.wire.complete(c, [{ role: 'user', content: 'Reply with OK only.' }]);
    if (!result.content) throw new NotFoundException('模型未返回文本，请检查模型配置');
    await this.audit.record(userId, 'ai.provider.test', 'ai_provider', id);
    return { success: true, model: c.model, message: result.content.slice(0, 300) };
  }
}
