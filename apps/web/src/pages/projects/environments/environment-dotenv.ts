export const hiddenVariableValue = '••••••••••••';

const variableName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const reservedName = /^VEYOPS_/i;

export type VariableDraft = {
  id: string;
  key: string;
  value?: string;
  isSecret: boolean;
  description: string;
  storedKey?: string;
  credentialId?: string;
  secretSource?: 'VALUE' | 'CREDENTIAL';
};

export function variableDraftError(rows: VariableDraft[]) {
  if (rows.length > 100) return '每个项目或环境最多可配置 100 个变量。';
  const names = new Set<string>();
  for (const row of rows) {
    const { key, value, isSecret, storedKey, description, credentialId } = row;
    if (!variableName.test(key)) return '变量名须由英文字母、数字或下划线组成，且不能以数字开头。';
    if (reservedName.test(key)) return `${key} 由系统提供。`;
    if (names.has(key)) return `变量 ${key} 重复。`;
    names.add(key);
    if (value === undefined && (!isSecret || (key !== storedKey && !credentialId)))
      return `请输入变量 ${key} 的值。`;
    if (isSecret && value === hiddenVariableValue) return `请输入变量 ${key} 的实际值。`;
    if (value && (value.length > 65_536 || value.includes('\0')))
      return `变量 ${key} 的值不能超过 65536 个字符或包含空字符。`;
    if (description.length > 1_000) return `变量 ${key} 的描述不能超过 1000 个字符。`;
  }
  return '';
}

const extendedEscapes: Record<string, string> = {
  '\\': '\\',
  '"': '"',
  "'": "'",
  '`': '`',
  '#': '#',
  n: '\n',
  r: '\r',
};
const escapeCodes = Object.fromEntries(
  Object.entries(extendedEscapes).map(([code, character]) => [character, code]),
);
const quotes = ['"', "'", '`'];

function readValue(lines: string[], index: number, first: string) {
  const quote = first[0];
  if (quote !== '"' && quote !== "'" && quote !== '`')
    return { value: first.split('#', 1)[0].trim(), index };

  let value = '';
  let extended = false;
  for (let line = index; line < lines.length; line++) {
    const content = line === index ? first.slice(1) : lines[line];
    for (let cursor = 0; cursor < content.length; cursor++) {
      const character = content[cursor];
      if (character === quote) {
        const suffix = content.slice(cursor + 1).trim();
        if (!suffix || suffix.startsWith('#')) {
          if (extended)
            value = value.replace(/\\([\\"'`#nr])/g, (_, code: string) => extendedEscapes[code]);
          else if (quote === '"')
            value = value.replace(/\\([nr])/g, (_, code: string) => extendedEscapes[code]);
          return { value, index: line };
        }
        let slash = cursor - 1;
        while (content[slash] === '\\') slash--;
        if ((cursor - 1 - slash) % 2 === 0) throw new Error('引号后的内容须为行尾注释。');
        extended = true;
      }
      value += character;
    }
    value += '\n';
  }
  throw new Error('变量值的引号未闭合。');
}

export function parseVariables(input: string, current: VariableDraft[]): VariableDraft[] {
  const previous = new Map(current.map((row) => [row.key, row]));
  const declarations = new Map<string, { value: string; line: number }>();
  const markers = new Map<string, number>();
  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trimStart();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (!/^#\s*@secret(?:\s|$)/.test(line)) continue;
      const key = /^#\s*@secret\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line)?.[1];
      if (!key || !variableName.test(key)) throw new Error(`第 ${index + 1} 行的敏感标记无效。`);
      if (markers.has(key)) throw new Error(`第 ${index + 1} 行的敏感标记 ${key} 重复。`);
      markers.set(key, index + 1);
      continue;
    }
    const assignment = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]{0,127})[ \t]*=[ \t]*/.exec(line);
    if (!assignment) throw new Error(`第 ${index + 1} 行须使用 KEY=VALUE 格式。`);
    const key = assignment[1];
    if (declarations.has(key)) throw new Error(`第 ${index + 1} 行的变量 ${key} 重复。`);
    try {
      const result = readValue(lines, index, line.slice(assignment[0].length));
      declarations.set(key, { value: result.value, line: index + 1 });
      index = result.index;
    } catch (error) {
      throw new Error(`第 ${index + 1} 行${(error as Error).message}`);
    }
  }

  for (const [key, line] of markers) {
    if ((declarations.get(key)?.line ?? 0) <= line)
      throw new Error(`第 ${line} 行的敏感标记 ${key} 缺少对应的下方变量。`);
  }

  return Array.from(declarations, ([key, { value, line }]) => {
    const prior = previous.get(key);
    const isSecret = markers.has(key);
    if (value === hiddenVariableValue && !prior?.isSecret && isSecret)
      throw new Error(`第 ${line} 行的变量 ${key} 没有可保留的敏感值。`);
    if (value === hiddenVariableValue && prior?.isSecret && !isSecret)
      throw new Error(`第 ${line} 行须保留 ${key} 的敏感标记或输入新的值。`);
    if (isSecret && prior?.isSecret && value === hiddenVariableValue) return prior;
    return {
      id: prior?.id ?? `dotenv-${key}`,
      key,
      value,
      isSecret,
      description: prior?.description ?? '',
      storedKey: prior?.storedKey,
    };
  });
}

export function formatVariables(rows: VariableDraft[], revealed?: ReadonlyMap<string, string>) {
  return rows
    .flatMap(({ key, value, isSecret }) => {
      const display = isSecret
        ? ((revealed && (value ?? revealed.get(key))) ?? hiddenVariableValue)
        : (value ?? '');
      return [...(isSecret ? [`# @secret ${key}`] : []), `${key}=${formatValue(display)}`];
    })
    .join('\n');
}

function formatValue(value: string) {
  if (/^[a-zA-Z0-9_./:@%+,=\-]*$/.test(value) || value === hiddenVariableValue) return value;
  const quote = quotes.find(
    (character) =>
      !value.includes(character) &&
      (character === '"' ? !/\\[nr]/.test(value) : !value.includes('\r')),
  );
  if (quote) {
    const content = quote === '"' ? value.replace(/\r/g, '\\r').replace(/\n/g, '\\n') : value;
    return `${quote}${content}${quote}`;
  }

  // An escaped delimiter keeps values with mixed quotes and literal escapes reversible.
  const delimiter = quotes.find((character) => value.includes(character)) ?? '"';
  const encoded = value.replace(/[\\"'`#\r\n]/g, (character) => `\\${escapeCodes[character]}`);
  return `${delimiter}${encoded}${delimiter}`;
}
