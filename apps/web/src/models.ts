export interface User {
  id: string;
  username: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
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
}
export interface Service {
  id: string;
  name: string;
  slug: string;
  serviceType: string;
}
export interface Environment {
  id: string;
  name: string;
  slug: string;
  environmentType: string;
}
export interface ProjectDetail extends Project {
  repositories: Repository[];
  services: Service[];
  environments: Environment[];
}
export interface Task {
  id: string;
  type: string;
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
}
export interface Plan {
  id: string;
  name: string;
  description: string;
  category: string;
  currentVersion: number;
  version?: number;
  steps: { name: string; command: string; timeout?: number }[];
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
