import { ExecutionPlanIssueError } from '../../core/execution-plan-issue';
import { redactText } from '../../infrastructure/ssh/secret-redactor';
import { redactTaskLog } from '../tasks/task-log.service';
import { graphRecord, validateGraphValue, type GraphField } from './graph-fields';

const prefix = 'VEYOPS_OUTPUT=';
const maximumResultBytes = 64 * 1024;

function outputIssue(message: string, field?: GraphField): never {
  throw new ExecutionPlanIssueError({
    code: 'CONFIGURATION',
    message,
    fieldId: field?.id,
    fieldName: field?.name,
  });
}

/** The process runner bounds the stream. Keep only one result line for typed decoding. */
export class GraphScriptOutput {
  private pending = { stdout: '', stderr: '' };
  private declaration?: string;
  private multiple = false;
  private tooLarge = false;
  private received = false;
  private readonly maskedPrefix: string;

  constructor(
    private readonly log: (line: string) => void,
    private readonly secrets: string[],
  ) {
    this.maskedPrefix = redactText(prefix, secrets);
  }

  write(text: string, stream: 'stdout' | 'stderr') {
    if (!text) return;
    this.received = true;
    const lines = (this.pending[stream] + text).split('\n');
    this.pending[stream] = lines.pop()!;
    for (const line of lines) this.line(line, stream, '\n');
  }

  finish(captured?: { stdout: string; stderr: string }) {
    if (!this.received && captured) {
      this.write(redactText(captured.stdout, this.secrets), 'stdout');
      this.write(redactText(captured.stderr, this.secrets), 'stderr');
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      const line = this.pending[stream];
      this.pending[stream] = '';
      if (line) this.line(line, stream, '');
    }
  }

  private line(line: string, stream: 'stdout' | 'stderr', newline: string) {
    if (!line.startsWith(prefix)) {
      if (this.maskedPrefix === prefix || !line.startsWith(this.maskedPrefix))
        this.log(line + newline);
      return;
    }
    if (stream !== 'stdout') return;
    if (this.declaration !== undefined || this.tooLarge) {
      this.multiple = true;
      return;
    }
    const declaration = line.slice(prefix.length).replace(/\r$/, '');
    if (Buffer.byteLength(declaration) > maximumResultBytes) this.tooLarge = true;
    else this.declaration = declaration;
  }

  values(fields: readonly GraphField[]) {
    if (this.multiple) outputIssue('脚本只能通过 stdout 提交一条 VEYOPS_OUTPUT 结果');
    if (this.tooLarge) outputIssue('脚本结构化结果超过 64 KiB');
    let values: unknown = {};
    if (this.declaration !== undefined) {
      if (this.declaration.includes('[REDACTED]')) outputIssue('脚本结构化结果含敏感信息');
      try {
        values = JSON.parse(this.declaration) as unknown;
      } catch {
        outputIssue('脚本结构化结果须为 JSON 对象');
      }
    }
    if (!graphRecord(values)) outputIssue('脚本结构化结果须为 JSON 对象');
    const result = values;

    const declarations = new Map(fields.map((field) => [field.exportName ?? field.id, field]));
    const provided = new Set<string>();
    // Scan complete JSON string tokens after parsing so escaped keys compare by their decoded value.
    const tokens = this.declaration?.matchAll(/("(?:[^"\\]|\\.)*")\s*(:)?/gs) ?? [];
    for (const [, token, colon] of tokens) {
      if (!colon || !token) continue;
      const key = JSON.parse(token) as string;
      const field = declarations.get(key);
      if (!field) outputIssue('脚本结构化结果包含未声明的输出');
      if (provided.has(key)) outputIssue('脚本重复提供输出「' + field.name + '」', field);
      provided.add(key);
    }

    return Object.fromEntries(
      [...declarations].flatMap(([name, field]) => {
        const present = Object.hasOwn(result, name);
        if (!present && field.required === false) return [];
        const value = present ? result[name] : undefined;
        if (!validateGraphValue({ ...field, required: true }, value))
          outputIssue('脚本未提供有效的「' + field.name + '」输出', field);
        for (const scalar of Array.isArray(value) ? value : [value]) {
          if (
            typeof scalar === 'string' &&
            (redactText(scalar, this.secrets) !== scalar || redactTaskLog(scalar) !== scalar)
          )
            outputIssue('脚本输出「' + field.name + '」含敏感信息', field);
        }
        return [[field.id, value]];
      }),
    );
  }
}
