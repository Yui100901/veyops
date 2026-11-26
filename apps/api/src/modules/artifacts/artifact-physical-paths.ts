import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hash } from 'node:crypto';

export type PathArtifactKind = 'FILE' | 'DIRECTORY';
export type ArtifactDigest = { sha256: string; sizeBytes: number };

export class InvalidArtifactObject extends Error {}

function directoryEntry(hash: Hash, path: Buffer, file?: ArtifactDigest) {
  hash.update(file ? 'F\0' : 'D\0');
  hash.update(path);
  hash.update('\0');
  if (file) hash.update(file.sha256 + '\0' + file.sizeBytes + '\0');
}

async function fileDigest(path: string, signal?: AbortSignal): Promise<ArtifactDigest> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

/** v1 manifest. Paths are sorted by their UTF-8 bytes, and symlinks/special files are rejected. */
export async function artifactPathDigest(
  path: string,
  kind: PathArtifactKind,
  signal?: AbortSignal,
  filter?: (relativePath: string, name: string) => boolean,
): Promise<ArtifactDigest> {
  const root = await lstat(path);
  if (kind === 'FILE' && root.isFile()) return fileDigest(path, signal);
  if (kind !== 'DIRECTORY' || !root.isDirectory()) throw new InvalidArtifactObject();
  const names: { relative: string; nameBytes: Buffer; file: boolean }[] = [];
  const walk = async (directory: string, relativeDirectory: string) => {
    signal?.throwIfAborted();
    const entries = await readdir(directory, { encoding: 'buffer', withFileTypes: true });
    for (const entry of entries) {
      const name = new TextDecoder('utf-8', { fatal: true }).decode(entry.name);
      const relative = relativeDirectory ? relativeDirectory + '/' + name : name;
      if (filter && (!filter(relative, name) || (!entry.isDirectory() && !entry.isFile())))
        continue;
      if (!entry.isDirectory() && !entry.isFile()) throw new InvalidArtifactObject();
      names.push({ relative, nameBytes: Buffer.from('./' + relative), file: entry.isFile() });
      if (entry.isDirectory()) await walk(join(directory, name), relative);
    }
  };
  await walk(path, '');
  names.sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes));
  const hash = createHash('sha256');
  hash.update('veyops-directory-v1\0');
  let sizeBytes = 0;
  for (const entry of names) {
    const candidate = join(path, ...entry.relative.split('/'));
    const current = await lstat(candidate);
    if (entry.file !== current.isFile() || (!entry.file && !current.isDirectory()))
      throw new InvalidArtifactObject();
    const digest = entry.file ? await fileDigest(candidate, signal) : undefined;
    directoryEntry(hash, entry.nameBytes, digest);
    sizeBytes += digest?.sizeBytes ?? 0;
    if (!Number.isSafeInteger(sizeBytes)) throw new InvalidArtifactObject();
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

/** The host only emits the final digest and size, never the full manifest. */
export const linuxArtifactDigest = String.raw`
export LC_ALL=C
checksum() {
  local result
  result=$(sha256sum < "$1") || return 1
  printf '%s' "$(cut -d' ' -f1 <<< "$result")"
}
directory_manifest() (
  local directory="$1" name digest bytes
  cd -P -- "$directory" || exit 1
  printf 'veyops-directory-v1\0'
  find . -mindepth 1 -print0 | sort -z | while IFS= read -r -d '' name; do
    if [[ -L "$name" ]]; then exit 45; fi
    if [[ -d "$name" ]]; then
      printf 'D\0%s\0' "$name"
    elif [[ -f "$name" ]]; then
      digest=$(checksum "$name") || exit 1
      bytes=$(stat -c '%s' -- "$name") || exit 1
      printf 'F\0%s\0%s\0%s\0' "$name" "$digest" "$bytes"
    else
      exit 45
    fi
  done
)
artifact_digest() {
  local kind="$1" path="$2" digest bytes
  if [[ -L "$path" ]]; then return 45; fi
  if [[ "$kind" == FILE ]]; then
    [[ -f "$path" ]] || return 45
    digest=$(checksum "$path") || return 1
    bytes=$(stat -c '%s' -- "$path") || return 1
  else
    [[ -d "$path" ]] || return 45
    digest=$(directory_manifest "$path" | sha256sum | cut -d' ' -f1) || return $?
    bytes=$(find "$path" -type f -printf '%s\n' | awk '{n += $1} END {printf "%.0f", n}') || return 1
  fi
  printf '%s:%s' "$digest" "$bytes"
}
`;
