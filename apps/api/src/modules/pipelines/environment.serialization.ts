/** Docker Compose double-quoted env values: quote/escape literal text and disable interpolation. */
export function serializeComposeEnvironment(variables: Record<string, string>): string {
  return (
    Object.entries(variables)
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('无效Compose环境变量名');
        if (/[\x00-\x08\x0a-\x1f]/.test(value))
          throw new Error('Compose环境变量不支持换行和控制字符');
        const literal = value
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\t/g, '\\t')
          .replace(/\$/g, () => '$$');
        return `${key}="${literal}"`;
      })
      .join('\n') + '\n'
  );
}
