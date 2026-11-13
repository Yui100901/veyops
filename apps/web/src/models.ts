export interface User {
  id: string;
  username: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
  mustChangePassword: boolean;
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
  defaultBranch: string;
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
  description?: string;
}
export interface ProjectDetail extends Project {
  repositories: Repository[];
  services: Service[];
  environments: Environment[];
  addresses?: ProjectAddress[];
  dependencies?: ProjectDependency[];
  deploymentTargets?: ServerGroup[];
  pipelines?: { id: string; name: string; serviceId: string; version: number; enabled: boolean }[];
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
export interface Task {
  id: string;
  type: string;
  executionMode?: 'BUILD_ONLY' | 'DEPLOY' | null;
  pipelineRunId?: string | null;
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
  totalTasks: number;
  activeTasks: number;
  recentTasks: Task[];
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
