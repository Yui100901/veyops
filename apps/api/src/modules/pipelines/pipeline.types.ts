import type { SshTarget } from '../../infrastructure/ssh/ssh.service';

export interface PipelineStep {
  name: string;
  type: 'SHELL';
  command: string;
  timeout?: number;
}
export interface PipelineDefinition {
  repositoryId: string;
  buildLocation: 'TARGET' | 'MANAGER';
  artifactType: 'FILE' | 'DOCKER_IMAGE';
  buildImage: string;
  repoPath: string;
  installCommand: string;
  buildCommand: string;
  outputPath: string;
  deployPath: string;
  startCommand: string;
  healthCheckCommand: string;
  dockerfilePath: string;
  composeFilePath: string;
  registryId?: string;
  imageRepository?: string;
  steps: PipelineStep[];
}
export interface PipelineSnapshot {
  runId: string;
  pipelineId: string;
  pipelineVersionId: string;
  projectId: string;
  serviceId: string;
  environmentId: string;
  targetId: string;
  commitSha: string;
  repository: { url: string; credentialId: string | null };
  definition: PipelineDefinition;
  variables: Record<string, string>;
  secretVariables: Record<string, string>;
}
export interface PipelineArtifact {
  id: string;
  storageKey: string;
  checksum?: string;
  sizeBytes?: number;
  imageDigest?: string;
  imageReference?: string;
  serverId?: string;
}
export interface BuildOutput {
  localArchive?: string;
  localCompose?: string;
  imageReference?: string;
  imageDigest?: string;
  checksum?: string;
  sizeBytes?: number;
  cleanup: () => Promise<void>;
}
export type PipelineTarget = SshTarget;
