import { BadRequestException } from '@nestjs/common';

export function httpCloneUrl(value: string): string {
  if (
    !/^https?:\/\//i.test(value) ||
    /\s|\\/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new BadRequestException('仓库查询需要有效的 HTTP(S) 克隆地址');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('仓库查询需要有效的 HTTP(S) 克隆地址');
  }
  if (url.username || url.password || value.includes('?') || value.includes('#'))
    throw new BadRequestException('仓库地址不能包含凭据、查询或片段');
  return url.href;
}

/** Recognize a graph repository address without making a connection to it. */
export function graphRepositoryUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value))
    return undefined;
  try {
    return httpCloneUrl(value);
  } catch {
    return undefined;
  }
}
