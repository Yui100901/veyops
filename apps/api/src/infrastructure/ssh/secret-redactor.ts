const shellTraceEscapes: Record<string, string> = {
  '\\': '\\\\',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
  '\v': '\\v',
  '\x1b': '\\E',
};

function secretPatterns(values: string[]) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .flatMap((value) => [
          value,
          value.replace(/'/g, "'\\''"),
          value.replace(/'/g, `'"'"'`),
          value.replace(/[\\'\n\r\t\b\f\v\x1b]/g, (character) => shellTraceEscapes[character]!),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);
}

/** Buffers incomplete secret values so chunk boundaries cannot leak credentials. */
export class SecretRedactor {
  private pending = '';
  private readonly byInitial = new Map<string, string[]>();
  constructor(values: string[]) {
    for (const secret of secretPatterns(values)) {
      const initial = secret[0]!;
      const existing = this.byInitial.get(initial);
      if (existing) existing.push(secret);
      else this.byInitial.set(initial, [secret]);
    }
  }
  write(chunk: string): string {
    if (!this.byInitial.size) return chunk;
    this.pending += chunk;
    let result = '';
    let index = 0;
    while (index < this.pending.length) {
      const remaining = this.pending.length - index;
      const match = this.byInitial
        .get(this.pending[index]!)
        ?.find((secret) =>
          secret.length <= remaining
            ? this.pending.startsWith(secret, index)
            : secret.startsWith(this.pending.slice(index)),
        );
      if (match && match.length > remaining) break;
      if (match) {
        result += '[REDACTED]';
        index += match.length;
        continue;
      }
      result += this.pending[index++];
    }
    this.pending = this.pending.slice(index);
    return result;
  }
  end(): string {
    const result = this.pending ? '[REDACTED]' : '';
    this.pending = '';
    return result;
  }
}

export function redactText(text: string, values: string[]): string {
  return secretPatterns(values).reduce(
    (result, value) => result.split(value).join('[REDACTED]'),
    text,
  );
}
