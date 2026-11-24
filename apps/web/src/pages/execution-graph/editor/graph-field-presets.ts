import type { GraphCatalog, GraphField, GraphFieldType } from '../execution-graph-definition';

const references: Record<string, string> = {
  repository: 'GIT_REPOSITORY',
  repositoryId: 'GIT_REPOSITORY',
  version: 'GIT_VERSION',
  fetchMode: 'GIT_FETCH_MODE',
  commitSha: 'GIT_COMMIT_SHA',
  environment: 'PROJECT_ENVIRONMENT',
  service: 'PROJECT_SERVICE',
  path: 'ARTIFACT_DIR',
  outputDir: 'ARTIFACT_DIR',
};

const legacyReferences: Record<string, string> = {
  GIT_REPOSITORY_NAME: 'GIT_REPOSITORY',
  REPOSITORY: 'GIT_REPOSITORY',
  VERSION: 'GIT_VERSION',
  FETCH_MODE: 'GIT_FETCH_MODE',
  ENVIRONMENT: 'PROJECT_ENVIRONMENT',
  SERVICE: 'PROJECT_SERVICE',
  OUTPUT_DIR: 'ARTIFACT_DIR',
};

export const scriptInputTypes: GraphFieldType[] = [
  'TEXT',
  'NUMBER',
  'BOOLEAN',
  'REPOSITORY',
  'GIT_REF',
  'GIT_FETCH_MODE',
  'ENVIRONMENT',
  'ENVIRONMENT_SET',
  'SERVICE',
  'TARGETS',
  'ARTIFACT',
  'PATH',
  'IMAGE',
  'CREDENTIAL',
];
export const scriptOutputTypes: GraphFieldType[] = [
  'TEXT',
  'NUMBER',
  'BOOLEAN',
  'GIT_FETCH_MODE',
  'PATH',
  'REPOSITORY',
  'SERVICE',
];

export function suggestedGraphPortReference(id: string) {
  return (
    references[id] ??
    id
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replaceAll('-', '_')
      .toUpperCase()
  );
}

export function presetReference(field: GraphField) {
  return field.referenceName ?? suggestedGraphPortReference(field.id);
}

export function matchingGraphPreset(
  reference: string | undefined,
  catalog: GraphCatalog | undefined,
  input: boolean,
  accepts: (field: GraphField) => boolean = () => true,
) {
  if (!reference) return undefined;
  const standards = input ? catalog?.inputPresets : catalog?.outputPresets;
  const canonical = legacyReferences[reference] ?? reference;
  return standards?.find((field) => presetReference(field) === canonical && accepts(field));
}

export function graphPresetTypePatch(field: GraphField, preset?: GraphField): Partial<GraphField> {
  if (!preset || preset.type === field.type) return {};
  return {
    type: preset.type,
    defaultValue: undefined,
    artifactType: preset.artifactType,
    multiple: preset.multiple,
    options: undefined,
    selection: undefined,
    source: preset.source,
  };
}
