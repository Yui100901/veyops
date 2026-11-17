export function isGitBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith('-') &&
    name !== '@' &&
    !name.endsWith('.') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !/[ ~^:?*[\]\\]/.test(name) &&
    [...name].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
    name.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}
