import type { SshTarget } from '../../infrastructure/ssh/ssh.service';
import type { DeploymentSelection } from '../deployment-targets/deployment-selection';
import type { GraphExecutionScope } from '../execution-graphs/graph-workspace';
import type { GraphAutomation } from '../execution-graphs/graph-automatic-delivery';

export interface NamedArtifactDefinition {
  name: string;
  type: 'FILE' | 'DIRECTORY' | 'DOCKER_IMAGE';
  path?: string;
  collection?: 'WORK_DIRECTORY' | 'PATH';
  excludePaths?: string[];
  imageReference?: string;
  required?: boolean;
  persist?: boolean;
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
  managedCompose?: import('../service-configs/compose-template-reference').ManagedComposeReference;
  graphDeployment?: {
    method: 'FILE' | 'COMPOSE';
    artifactPath?: string;
    composeProject?: string;
    template?: Extract<
      import('../service-configs/compose-template-reference').ComposeTemplateReference,
      { source: 'REPOSITORY_FILE' }
    >;
  };
  graphGate?: import('../execution-graphs/graph-release-gates').GraphReleaseGate;
  graphRollback?: Record<string, string>;
  artifactSources?: import('../artifacts/artifact-sources').ArtifactSource[];
  graphReleaseTargets?: {
    source: import('./delivery-targets').DeliveryTargetSource;
    requested: import('../deployment-targets/deployment-selection').DeploymentSelectionDto;
    defaultParallel: number;
  };
  graph?: GraphExecutionScope;
  artifactRootRunId?: string;
  targetWorkspaceRoot?: string;
  releasePolicy?: ReleasePolicy;
  rollbackOfDeploymentId?: string;
  expectedCurrentDeploymentId?: string | null;
  releaseKey?: string;
  mode?: PipelineExecutionMode | 'DEPLOY_ARTIFACT';
  deployAfterBuild?: boolean;
  allowPartialDeploy?: boolean;
  deploymentArtifacts?: {
    id: string;
    serverId: string | null;
    sourceServerId?: string;
    fingerprint?: string;
  }[];
  sourceBuildTaskId?: string;
  artifactServiceScope?: boolean;
  triggerType?: 'MANUAL' | AutomaticPipelineTrigger | GraphAutomation['kind'];
  graphAutomation?: GraphAutomation;
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
  secretCredentialNonces?: Record<string, string>;
}
export interface PipelineArtifact {
  sources?: import('../artifacts/artifact-sources').ArtifactSource[];
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
  physical?: import('../artifacts/artifact-physical.service').ArtifactPhysical;
  persist?: boolean;
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
  physical?: import('../artifacts/artifact-physical.service').ArtifactPhysical;
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
