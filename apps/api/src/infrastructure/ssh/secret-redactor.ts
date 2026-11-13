/** Buffers incomplete secret values so chunk boundaries cannot leak credentials. */
export class SecretRedactor {
  private pending = '';
  private readonly secrets: string[];
  constructor(values: string[]) {
    this.secrets = [...new Set(values.filter((value) => value.length > 0))].sort(
      (a, b) => b.length - a.length,
    );
  }
  write(chunk: string): string {
    this.pending += chunk;
    let result = '';
    let index = 0;
    while (index < this.pending.length) {
      const match = this.secrets.find((secret) => this.pending.startsWith(secret, index));
      if (match) {
        result += '[REDACTED]';
        index += match.length;
        continue;
      }
      const remaining = this.pending.slice(index);
      if (this.secrets.some((secret) => secret.startsWith(remaining))) break;
      result += this.pending[index++];
    }
    this.pending = this.pending.slice(index);
    return result;
  }
  end(): string {
    let result = this.pending;
    for (const secret of this.secrets) result = result.split(secret).join('[REDACTED]');
    if (result && this.secrets.some((secret) => secret.startsWith(result))) result = '[REDACTED]';
    this.pending = '';
    return result;
  }
}

export function redactText(text: string, values: string[]): string {
  return values
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((result, value) => result.split(value).join('[REDACTED]'), text);
}
