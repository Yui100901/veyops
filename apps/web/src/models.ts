export interface User {
  id: string;
  username: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
  mustChangePassword: boolean;
}
export const userRoleNames = {
  ADMIN: '管理员',
  OPERATOR: '操作员',
  VIEWER: '只读用户',
} satisfies Record<User['role'], string>;

export interface ManagedUser extends User {
  status: 'ACTIVE' | 'DISABLED';
  createdAt: number;
  updatedAt: number;
}
export interface SystemRuntimeDefaults {
  defaultBuildLocation: 'TARGET' | 'MANAGER';
  defaultMaxParallelTargets: number;
  logRetentionDays: number;
  targetWorkspaceRoot: string;
}
export type ProjectExecutionOverrides = {
  [Key in keyof SystemRuntimeDefaults]?: SystemRuntimeDefaults[Key] | null;
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
}
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
  updatedAt: number;
  groups: Pick<ServerGroup, 'id' | 'name'>[];
  projects: Pick<Project, 'id' | 'name' | 'slug'>[];
  recentDeployments: DeploymentSummary[];
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
export interface Service {
  id: string;
  name: string;
  slug: string;
  serviceType: string;
  description?: string;
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
  addresses?: ProjectAddress[];
  dependencies?: ProjectDependency[];
  deploymentTargets?: ServerGroup[];
  recentDeployments?: DeploymentSummary[];
}
export interface ProjectAddress {
  id: string;
  name: string;
  url: string;
  serviceId: string | null;
  environmentId: string | null;
  addressType: 'WEB' | 'API' | 'DOCS';
  visibility: 'INTERNAL' | 'PUBLIC';
  description: string;
}
export interface ProjectDependency {
  id: string;
  dependsOnProjectId: string;
  projectName: string;
  projectSlug: string;
  dependencyType: 'RUNTIME' | 'DEPLOYMENT';
  description: string;
}
export type DeliveryStepType =
  'CHECKOUT' | 'ENVIRONMENT' | 'INSTALL' | 'BUILD' | 'TEST' | 'SHELL' | 'PACKAGE' | 'DEPLOY';
export interface DeliveryStepNode {
  id: string;
  name: string;
  type: DeliveryStepType;
}
export interface Task {
  id: string;
  createdBy?: string | null;
  projectId?: string | null;
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
