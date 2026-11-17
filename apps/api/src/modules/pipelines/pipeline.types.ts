import type { SshTarget } from '../../infrastructure/ssh/ssh.service';

export type PipelineExecutionMode = 'BUILD_ONLY' | 'DEPLOY';

export interface ReleasePolicy {
  requireApproval: boolean;
  archivePushedImage?: boolean;
  rollbackMode: 'OFF' | 'PREVIOUS_HEALTHY' | 'PINNED';
  pinnedDeploymentId?: string;
  healthCheck: {
    httpUrl?: string;
    compose?: boolean;
    attempts: number;
    intervalSeconds: number;
    timeoutSeconds: number;
  };
}

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
  stopCommand?: string;
  healthCheckCommand: string;
  dockerfilePath: string;
  composeFilePath: string;
  registryId?: string;
  imageRepository?: string;
  steps: PipelineStep[];
}
export interface PipelineSnapshot {
  releasePolicy?: ReleasePolicy;
  rollbackOfDeploymentId?: string;
  expectedCurrentDeploymentId?: string | null;
  releaseKey?: string;
  mode?: PipelineExecutionMode | 'DEPLOY_ARTIFACT';
  deployAfterBuild?: boolean;
  allowPartialDeploy?: boolean;
  deploymentArtifacts?: { id: string; serverId: string | null; fingerprint?: string }[];
  sourceBuildTaskId?: string;
  triggerType?: 'MANUAL' | 'WEBHOOK';
  runId: string;
  pipelineId: string;
  pipelineVersionId: string;
  projectId: string;
  serviceId: string;
  environmentId: string;
  targetId: string;
  commitSha: string;
  repository: { url: string; credentialId: string | null };
  registry?: { registryUrl: string; credentialId: string | null };
  definition: PipelineDefinition;
  variables: Record<string, string>;
  secretVariables: Record<string, string>;
}
export interface PipelineArtifact {
  id: string;
  storageKey: string;
  archiveKey?: string;
  archiveImageId?: string;
  archiveImagePlatform?: string;
  storageType?: 'LOCAL_FILE' | 'REMOTE_FILE' | 'LOCAL_IMAGE' | 'REMOTE_IMAGE' | 'REGISTRY_IMAGE';
  composeYaml?: string;
  checksum?: string;
  sizeBytes?: number;
  imageDigest?: string;
  imageReference?: string;
  imageTag?: string;
  imageId?: string;
  serverId?: string;
}
export interface BuildOutput {
  localArchive?: string;
  archiveKey?: string;
  archiveImageId?: string;
  archiveImagePlatform?: string;
  localCompose?: string;
  composeYaml?: string;
  imageReference?: string;
  imageDigest?: string;
  imageTag?: string;
  imageId?: string;
  checksum?: string;
  sizeBytes?: number;
  cleanup: () => Promise<void>;
}
export type PipelineTarget = SshTarget;
