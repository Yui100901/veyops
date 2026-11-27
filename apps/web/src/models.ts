export interface User {
  id: string;
  username: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
  mustChangePassword: boolean;
  passwordChangeRecommended: boolean;
}
export const userRoleNames = {
  ADMIN: '管理员',
  OPERATOR: '操作员',
  VIEWER: '只读用户',
} satisfies Record<User['role'], string>;

export interface ManagedUser extends Omit<User, 'passwordChangeRecommended'> {
  status: 'ACTIVE' | 'DISABLED';
  createdAt: number;
  updatedAt: number;
}
export interface SystemRuntimeDefaults {
  defaultMaxParallelTargets: number;
  defaultOperationFailurePolicy: 'CONTINUE' | 'STOP';
  defaultOperationTimeoutSeconds: number;
  maxConcurrentFlowsPerServer: number;
  logRetentionDays: number;
  targetWorkspaceRoot: string;
}
export type ProjectExecutionOverrides = {
  [Key in 'defaultMaxParallelTargets' | 'logRetentionDays' | 'targetWorkspaceRoot']?:
    SystemRuntimeDefaults[Key] | null;
};
export interface ProjectExecutionSettings {
  system: SystemRuntimeDefaults;
  overrides: ProjectExecutionOverrides;
  effective: SystemRuntimeDefaults;
}
export interface Credential {
  id: string;
  name: string;
  type: string;
  status: string;
  createdAt: number;
}
export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  credentialId: string;
  hostKeyFingerprint: string;
  automaticExecutionEnabled?: boolean;
  tags: string[];
  status: string;
  lastCheckedAt: number | null;
  osType: string | null;
  description?: string;
}
export interface ServerGroup {
  id: string;
  name: string;
  description?: string;
  serverIds: string[];
  projects?: ServerProjectReference[];
  deployedServices?: ServerDeployedService[];
  recentDeployments?: DeploymentSummary[];
}
export interface ServerDeployedService {
  projectId: string;
  projectName: string;
  serviceId: string;
  serviceName: string;
  serverId: string;
  serverName: string | null;
  scopeKey: string;
  method?: 'FILE' | 'COMPOSE';
  location?: string;
  current: ServerReleaseHead;
  latestAttempt: ServerReleaseHead;
}
export interface ServerReleaseHead {
  status: string;
  healthStatus: string | null;
  healthObservedAt: number | null;
  environmentName: string | null;
  releaseVersion?: string | null;
  deploymentRecordId: string | null;
  releaseTaskId: string;
  startedAt: number;
  finishedAt: number | null;
  errorSummary: string | null;
}
export interface ServerProjectReference extends Pick<Project, 'id' | 'name' | 'slug'> {
  references?: {
    sourceKind: string;
    sourceId: string;
    state: string;
    serviceId?: string;
    version?: number;
    flowId?: string;
    flowName?: string;
    nodeId?: string;
    nodeName?: string;
    fieldId?: string;
    runId?: string;
    taskId?: string;
    label?: string;
  }[];
}
export interface DeploymentSelection {
  targetId?: string | null;
  serverIds?: string[];
  groupIds?: string[];
  strategy?: 'PARALLEL' | 'SEQUENTIAL';
  maxParallel?: number;
  failurePolicy?: 'CONTINUE' | 'STOP';
}
export interface DeploymentSummary {
  id: string;
  taskId: string;
  serviceId: string;
  environmentId: string;
  serverId: string;
  status: string;
  healthStatus: string;
  releaseVersion: string;
  startedAt: number | null;
  finishedAt: number | null;
  projectId?: string;
}
export interface DeploymentRecord extends DeploymentSummary {
  artifactId?: string | null;
  deployPath?: string;
  previousDeploymentId?: string | null;
  rollbackAvailable?: boolean;
  rollbackUnavailableReason?: string;
  isCurrent?: boolean;
  rollbackOfDeploymentId?: string | null;
  rollbackStatus?: string | null;
  composeRelease?: ComposeReleaseEvidence;
}
export type ComposeTemplateReference =
  | { source: 'ARCHIVE'; path?: string; checksum: string }
  | {
      source: 'REPOSITORY_FILE';
      path: string;
      repositoryId: string;
      commitSha: string;
      checksum: string;
    }
  | { source: 'SERVICE_ENVIRONMENT'; path: string; version: number; checksum: string };
export type ComposeReleaseEvidence = {
  template: ComposeTemplateReference;
  imageReference: string;
  imageId: string;
  images?: { artifactId: string; imageReference: string; imageId: string }[];
  composeProject?: string;
  dockerEngineId?: string;
};
export interface ReleasePolicy {
  requireApproval: boolean;
  requireCodeReview?: boolean;
  rollbackMode: 'OFF' | 'PREVIOUS_HEALTHY' | 'PINNED';
  pinnedDeploymentId?: string | null;
  archivePushedImage?: boolean;
  healthCheck: {
    httpUrl?: string | null;
    compose?: boolean;
    attempts: number;
    intervalSeconds: number;
    timeoutSeconds: number;
  };
}
export interface ServerDetail extends Server {
  active?: boolean;
  updatedAt: number;
  groups: Pick<ServerGroup, 'id' | 'name'>[];
  projects: ServerProjectReference[];
  recentDeployments: DeploymentSummary[];
  deployedServices: ServerDeployedService[];
  recentCommands: {
    id: string;
    taskId: string;
    taskType: string;
    name: string;
    status: string;
    exitCode: number | null;
    startedAt: number | null;
    finishedAt: number | null;
  }[];
  probeHistory: {
    id: string;
    status: string;
    checkedAt: number;
    osType: string | null;
    metrics?: {
      loadAverage: string;
      memoryTotalKb: number;
      memoryAvailableKb: number;
      diskTotalKb: number;
      diskAvailableKb: number;
    };
  }[];
}
export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  status: string;
  createdAt: number;
  serviceCount: number;
  environmentCount: number;
  environmentSetCount?: number;
}
export interface Repository {
  id: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string | null;
  branchSyncStatus: 'PENDING' | 'CURRENT' | 'STALE' | 'ERROR';
  branchCount: number;
  provider?: string;
  credentialId?: string | null;
  description?: string;
}
export interface ServiceAddressBinding {
  serverId: string;
  protocol: 'http' | 'https';
  port: number;
  host?: string;
  externalPort?: number;
  path?: string;
}
export interface ServiceAddress {
  id: string;
  name: string;
  url: string;
  binding?: ServiceAddressBinding;
}
export interface Service {
  id: string;
  name: string;
  slug: string;
  serviceType: string;
  description?: string;
  revision: number;
  addresses: ServiceAddress[];
}
export interface Environment {
  id: string;
  name: string;
  slug: string;
  environmentType: string;
  repositoryEnvFile?: string | null;
  defaultTargetSelection?: DeploymentSelection | null;
  description?: string;
}
export interface ProjectDetail extends Project {
  archived?: boolean;
  repositories: Repository[];
  services: Service[];
  environments: Environment[];
  archivedServices?: Pick<Service, 'id' | 'name'>[];
  archivedEnvironments?: Pick<Environment, 'id' | 'name'>[];
  archivedRepositories?: string[];
  deploymentTargets?: ServerGroup[];
  recentDeployments?: DeploymentSummary[];
}
export type DeliveryStepType =
  'CHECKOUT' | 'ENVIRONMENT' | 'INSTALL' | 'BUILD' | 'TEST' | 'SHELL' | 'PACKAGE' | 'DEPLOY';
export interface DeliveryStepNode {
  id: string;
  name: string;
  type: DeliveryStepType;
}
export interface Task {
  interactive?: boolean;
  id: string;
  canReuseCommand?: boolean;
  flowRunId?: string;
  flowNodeId?: string;
  createdBy?: string | null;
  projectId?: string | null;
  projectName?: string;
  serviceId?: string | null;
  environmentId?: string | null;
  type: string;
  executionMode?: 'BUILD_ONLY' | 'DEPLOY' | 'DEPLOY_ARTIFACT' | null;
  approvalStatus?: 'PENDING' | 'APPROVED' | null;
  deliveryStage?: 'BUILD' | 'DEPLOY' | null;
  sourceBuildTaskId?: string | null;
  deploymentTaskId?: string | null;
  deploymentSkippedReason?: string | null;
  deployAfterBuild?: boolean;
  pipelineRunId?: string | null;
  pipelineGraph?: { buildLocation: 'TARGET' | 'MANAGER'; nodes: DeliveryStepNode[] };
  result?: {
    aiAnalysis?:
      | { status: 'SUCCESS'; summary: string; failedPhase: string | null; nextActions: string[] }
      | { status: 'UNAVAILABLE' };
  } | null;
  name: string;
  status: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  errorSummary?: string;
  errorMessage?: string;
}
export interface TaskTarget {
  id: string;
  serverId: string;
  serverName: string;
  host: string;
  status: string;
  exitCode: number | null;
  errorSummary?: string;
  canRetry?: boolean;
}
export type ParameterValue = string | number | boolean;
export interface OperationParameter {
  name: string;
  type: 'STRING' | 'NUMBER' | 'BOOLEAN';
  required?: boolean;
  defaultValue?: ParameterValue;
  description?: string;
}
export interface OperationStep {
  name: string;
  command: string;
  timeout?: number;
  failurePolicy?: 'STOP' | 'CONTINUE';
}
export interface Plan {
  id: string;
  name: string;
  description: string;
  category: string;
  osRequirements?: string;
  currentVersion: number;
  version?: number;
  steps: OperationStep[];
  parameters?: OperationParameter[];
  preChecks?: OperationStep[];
  postChecks?: OperationStep[];
  enabled?: boolean;
}
export interface Dashboard {
  servers: { total: number; online: number; offline: number; unknown: number };
  projects: number;
  services: { total: number; running: number; abnormal: number };
  totalTasks: number;
  activeTasks: number;
  recentTasks: Task[];
  recentFailedTasks: Task[];
  recentDeployments: DashboardDeployment[];
}
export interface DashboardDeployment extends Omit<
  DeploymentSummary,
  'serverId' | 'healthStatus' | 'releaseVersion'
> {
  projectId: string;
  projectName: string;
  serviceName: string;
  environmentName: string;
  serverId: string | null;
  serverName: string;
  healthStatus: string | null;
  releaseVersion: string | null;
  createdAt: number;
}
export interface Audit {
  id: string;
  userId?: string;
  username?: string;
  actorId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  createdAt: number;
  details?: unknown;
}
