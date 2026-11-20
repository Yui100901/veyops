import type { SshTarget } from '../../infrastructure/ssh/ssh.service';
import type { DeploymentSelection } from '../deployment-targets/deployment-selection';
import type { GraphExecutionScope } from '../execution-graphs/graph-workspace';

export interface NamedArtifactDefinition {
  name: string;
  type: 'FILE' | 'DIRECTORY' | 'DOCKER_IMAGE';
  path?: string;
  imageReference?: string;
  required?: boolean;
  composeFilePath?: string;
}

export type PipelineExecutionMode = 'BUILD_ONLY' | 'DEPLOY';
export type AutomaticPipelineTrigger = 'WEBHOOK' | 'SCHEDULE' | 'POLL';

export interface ReleasePolicy {
  requireApproval: boolean;
  requireCodeReview?: boolean;
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
export const pipelineNodeTypes = [
  'CHECKOUT',
  'ENVIRONMENT',
  'INSTALL',
  'BUILD',
  'TEST',
  'SHELL',
  'PACKAGE',
  'DEPLOY',
] as const;
export interface PipelineNodeVariable {
  key: string;
  value?: string;
  credentialId?: string;
}
export interface PipelineNode {
  id: string;
  name: string;
  type: (typeof pipelineNodeTypes)[number];
  repositoryId?: string;
  branch?: string;
  environmentBranches?: Record<string, string>;
  directory?: string;
  command?: string;
  timeout?: number;
  variables?: PipelineNodeVariable[];
  envFile?: string;
}
export interface PipelineNodeSource {
  url: string;
  credentialId: string | null;
  commitSha: string;
  branch?: string;
}
export interface PipelineDefinition {
  artifacts?: NamedArtifactDefinition[];
  inheritBuildLocation?: boolean;
  defaultMode?: PipelineExecutionMode;
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
  nodes?: PipelineNode[];
}
export interface PipelineSnapshot {
  graph?: GraphExecutionScope;
  targetWorkspaceRoot?: string;
  releasePolicy?: ReleasePolicy;
  rollbackOfDeploymentId?: string;
  expectedCurrentDeploymentId?: string | null;
  releaseKey?: string;
  mode?: PipelineExecutionMode | 'DEPLOY_ARTIFACT';
  deployAfterBuild?: boolean;
  allowPartialDeploy?: boolean;
  deploymentArtifacts?: { id: string; serverId: string | null; fingerprint?: string }[];
  sourceBuildTaskId?: string;
  artifactServiceScope?: boolean;
  triggerType?: 'MANUAL' | AutomaticPipelineTrigger;
  runId: string;
  pipelineId: string;
  pipelineVersionId: string;
  projectId: string;
  serviceId: string;
  projectName?: string;
  serviceName?: string;
  environmentId: string;
  targetId?: string;
  targetSelection?: DeploymentSelection;
  targetMemberIds?: string[];
  commitSha: string;
  repository: { url: string; credentialId: string | null };
  nodeSources?: Record<string, PipelineNodeSource>;
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
  name?: string;
  kind?: NamedArtifactDefinition['type'];
}
export interface BuildOutput {
  artifacts?: { declaration: NamedArtifactDefinition; output: BuildOutput }[];
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

export function isStandaloneGraphBuild(snapshot: PipelineSnapshot | undefined) {
  return Boolean(
    snapshot?.graph &&
    snapshot.mode === 'BUILD_ONLY' &&
    !snapshot.deployAfterBuild &&
    snapshot.definition.buildLocation === 'MANAGER',
  );
}

export type PipelineTarget = SshTarget;
