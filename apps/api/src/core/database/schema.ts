import type { Generated } from 'kysely';

/** Storage contract: UUID text IDs, UTC milliseconds, 0/1 flags and JSON text. */
export interface UsersTable {
  id: string;
  username: string;
  password_hash: string;
  role: Generated<string>;
  status: Generated<string>;
  created_at: number;
  updated_at: number;
}

export interface AuthSessionsTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  revoked_at: Generated<number | null>;
  created_at: number;
}

export interface SystemSettingsTable {
  key: string;
  value_json: string;
  updated_at: number;
}

export interface CredentialsTable {
  id: string;
  name: string;
  type: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  key_version: Generated<string>;
  metadata_json: Generated<string>;
  status: Generated<string>;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface ServersTable {
  id: string;
  name: string;
  host: string;
  port: Generated<number>;
  username: string;
  credential_id: Generated<string | null>;
  os_type: Generated<string | null>;
  host_key_fingerprint: Generated<string | null>;
  status: Generated<string>;
  last_checked_at: Generated<number | null>;
  tags_json: Generated<string>;
  is_active: Generated<number>;
  created_at: number;
  updated_at: number;
  description: Generated<string>;
}

export interface ServerGroupsTable {
  id: string;
  name: string;
  description: Generated<string>;
  created_at: number;
}

export interface ServerGroupMembersTable {
  group_id: string;
  server_id: string;
  created_at: number;
}

export interface ProjectsTable {
  id: string;
  name: string;
  slug: string;
  description: Generated<string>;
  icon: Generated<string>;
  tags_json: Generated<string>;
  status: Generated<string>;
  created_by: string;
  deleted_at: Generated<number | null>;
  created_at: number;
  updated_at: number;
}

export interface RepositoriesTable {
  id: string;
  project_id: string;
  name: string;
  provider: Generated<string>;
  clone_url: string;
  credential_id: Generated<string | null>;
  default_branch: Generated<string>;
  description: Generated<string>;
  created_at: number;
  updated_at: number;
}

export interface ServicesTable {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  service_type: Generated<string>;
  description: Generated<string>;
  default_build_config_json: Generated<string>;
  default_deploy_config_json: Generated<string>;
  created_at: number;
  updated_at: number;
}

export interface ServiceRepositoriesTable {
  service_id: string;
  repository_id: string;
  repo_path: Generated<string>;
  role: Generated<string>;
  is_primary: Generated<number>;
}

export interface EnvironmentsTable {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  environment_type: Generated<string>;
  description: Generated<string>;
  created_at: number;
  updated_at: number;
}

export interface DeploymentTargetsTable {
  id: string;
  name: string;
  description: Generated<string>;
  strategy: Generated<string>;
  max_parallel: Generated<number>;
  failure_policy: Generated<string>;
  created_at: number;
  updated_at: number;
}

export interface DeploymentTargetServersTable {
  target_id: string;
  server_id: string;
  sort_order: Generated<number>;
}

export interface ServiceEnvironmentConfigsTable {
  id: string;
  service_id: string;
  environment_id: string;
  target_id: Generated<string | null>;
  build_location: Generated<string | null>;
  artifact_type: Generated<string>;
  deploy_method: Generated<string>;
  working_directory: Generated<string>;
  build_command: Generated<string>;
  build_output_path: Generated<string>;
  dockerfile_path: Generated<string>;
  docker_context: Generated<string>;
  deploy_path: Generated<string>;
  compose_file_path: Generated<string>;
  compose_project_name: Generated<string>;
  start_command: Generated<string>;
  stop_command: Generated<string>;
  restart_command: Generated<string>;
  health_check_json: Generated<string>;
  config_json: Generated<string>;
  created_at: number;
  updated_at: number;
}

export interface EnvironmentVariablesTable {
  id: string;
  environment_id: string;
  key: string;
  value_text: Generated<string | null>;
  credential_id: Generated<string | null>;
  is_secret: Generated<number>;
}

export interface ServiceEnvironmentVariablesTable {
  id: string;
  config_id: string;
  key: string;
  value_text: Generated<string | null>;
  credential_id: Generated<string | null>;
  is_secret: Generated<number>;
}

export interface ProjectAddressesTable {
  id: string;
  project_id: string;
  service_id: Generated<string | null>;
  environment_id: Generated<string | null>;
  name: string;
  url: string;
  address_type: Generated<string>;
  visibility: Generated<string>;
  description: Generated<string>;
}

export interface ProjectDependenciesTable {
  id: string;
  project_id: string;
  depends_on_project_id: string;
  dependency_type: Generated<string>;
  description: Generated<string>;
}

export interface PipelinesTable {
  id: string;
  project_id: string;
  service_id: string;
  name: string;
  enabled: Generated<number>;
  current_version: Generated<number>;
  created_at: number;
  updated_at: number;
}

export interface PipelineVersionsTable {
  id: string;
  pipeline_id: string;
  version: number;
  schema_version: Generated<number>;
  definition_json: string;
  created_by: string;
  created_at: number;
}

export interface TasksTable {
  id: string;
  task_type: string;
  status: Generated<string>;
  origin: Generated<string>;
  priority: Generated<number>;
  created_by: string;
  project_id: Generated<string | null>;
  service_id: Generated<string | null>;
  environment_id: Generated<string | null>;
  target_id: Generated<string | null>;
  operation_plan_version_id: Generated<string | null>;
  payload_json: string;
  result_json: Generated<string | null>;
  idempotency_key: Generated<string | null>;
  attempt_count: Generated<number>;
  max_attempts: Generated<number>;
  available_at: Generated<number>;
  lease_owner: Generated<string | null>;
  lease_expires_at: Generated<number | null>;
  heartbeat_at: Generated<number | null>;
  cancel_requested_at: Generated<number | null>;
  started_at: Generated<number | null>;
  finished_at: Generated<number | null>;
  log_file_key: Generated<string | null>;
  log_size_bytes: Generated<number>;
  error_summary: Generated<string | null>;
  created_at: number;
  updated_at: number;
  name: Generated<string>;
}

export interface TaskTargetsTable {
  id: string;
  task_id: string;
  server_id: Generated<string | null>;
  server_name_snapshot: string;
  host_snapshot: string;
  status: Generated<string>;
  exit_code: Generated<number | null>;
  result_json: Generated<string | null>;
  started_at: Generated<number | null>;
  finished_at: Generated<number | null>;
  error_summary: Generated<string | null>;
  port_snapshot: Generated<number>;
  username_snapshot: Generated<string>;
  credential_id_snapshot: Generated<string | null>;
  fingerprint_snapshot: Generated<string | null>;
}

export interface TaskStepsTable {
  id: string;
  task_id: string;
  task_target_id: Generated<string | null>;
  execution_target_key: string;
  step_key: string;
  step_order: number;
  step_type: string;
  status: Generated<string>;
  input_json: Generated<string>;
  result_json: Generated<string | null>;
  exit_code: Generated<number | null>;
  started_at: Generated<number | null>;
  finished_at: Generated<number | null>;
}

export interface PipelineRunsTable {
  id: string;
  task_id: string;
  pipeline_id: string;
  pipeline_version_id: string;
  project_id: string;
  service_id: string;
  environment_id: string;
  target_id: string;
  git_ref: string;
  commit_sha: string;
  build_location_snapshot: string;
  artifact_type_snapshot: string;
  trigger_type: Generated<string>;
  created_at: number;
}

export interface RegistriesTable {
  id: string;
  name: string;
  registry_url: string;
  credential_id: Generated<string | null>;
  created_at: number;
}

export interface ArtifactsTable {
  id: string;
  project_id: string;
  service_id: string;
  pipeline_run_id: Generated<string | null>;
  artifact_type: string;
  storage_type: string;
  storage_key: string;
  server_id: Generated<string | null>;
  registry_id: Generated<string | null>;
  image_repository: Generated<string | null>;
  image_tag: Generated<string | null>;
  image_digest: Generated<string | null>;
  checksum: Generated<string | null>;
  size_bytes: Generated<number | null>;
  source_commit: Generated<string | null>;
  created_at: number;
}

export interface DeploymentRecordsTable {
  id: string;
  pipeline_run_id: string;
  artifact_id: Generated<string | null>;
  task_target_id: string;
  service_id: string;
  environment_id: string;
  server_id: Generated<string | null>;
  status: string;
  release_version: Generated<string | null>;
  deploy_path: Generated<string | null>;
  health_status: Generated<string | null>;
  previous_deployment_id: Generated<string | null>;
  started_at: Generated<number | null>;
  finished_at: Generated<number | null>;
}

export interface CommandTemplatesTable {
  id: string;
  name: string;
  description: Generated<string>;
  command_text: string;
  shell_type: Generated<string>;
  variables_schema_json: Generated<string>;
  risk_level: Generated<string>;
  timeout_seconds: Generated<number>;
  created_by: string;
  created_at: number;
}

export interface OperationPlansTable {
  id: string;
  name: string;
  description: Generated<string>;
  category: Generated<string>;
  enabled: Generated<number>;
  current_version: Generated<number>;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface OperationPlanVersionsTable {
  id: string;
  plan_id: string;
  version: number;
  schema_version: Generated<number>;
  definition_json: string;
  created_by: string;
  created_at: number;
}

export interface AiProvidersTable {
  id: string;
  name: string;
  base_url: string;
  model: string;
  credential_id: Generated<string | null>;
  timeout_seconds: Generated<number>;
  enabled: Generated<number>;
  created_at: number;
}

export interface AiPermissionPoliciesTable {
  id: string;
  scope_type: string;
  scope_key: string;
  project_id: Generated<string | null>;
  mode: Generated<string>;
  scope_json: Generated<string>;
  created_at: number;
  updated_at: number;
}

export interface AiPolicyRulesTable {
  id: string;
  policy_id: string;
  action_category: string;
  effect: string;
  target_type: Generated<string>;
  target_id: Generated<string | null>;
  conditions_json: Generated<string>;
  created_at: number;
}

export interface AiActionProposalsTable {
  id: string;
  created_by: string;
  action_type: string;
  payload_json: string;
  preview_json: string;
  risk_level: string;
  policy_snapshot_json: Generated<string | null>;
  status: Generated<string>;
  expires_at: number;
  confirmed_by: Generated<string | null>;
  confirmed_at: Generated<number | null>;
  task_id: Generated<string | null>;
  created_at: number;
}

export interface AiConversationsTable {
  id: string;
  user_id: string;
  title: string;
  project_id: Generated<string | null>;
  created_at: number;
  updated_at: number;
}

export interface AiMessagesTable {
  id: string;
  conversation_id: string;
  role: string;
  content_json: string;
  tool_call_json: Generated<string | null>;
  created_at: number;
}

export interface ViewsTable {
  id: string;
  name: string;
  description: Generated<string>;
  created_by: string;
  is_default: Generated<number>;
  created_at: number;
}

export interface ViewProjectsTable {
  view_id: string;
  project_id: string;
  sort_order: Generated<number>;
}

export interface AuditLogsTable {
  id: string;
  actor_type: string;
  user_id: Generated<string | null>;
  action: string;
  resource_type: string;
  resource_id: Generated<string | null>;
  request_id: Generated<string | null>;
  details_json: Generated<string>;
  created_at: number;
}

export interface Database {
  users: UsersTable;
  auth_sessions: AuthSessionsTable;
  system_settings: SystemSettingsTable;
  credentials: CredentialsTable;
  servers: ServersTable;
  server_groups: ServerGroupsTable;
  server_group_members: ServerGroupMembersTable;
  projects: ProjectsTable;
  repositories: RepositoriesTable;
  services: ServicesTable;
  service_repositories: ServiceRepositoriesTable;
  environments: EnvironmentsTable;
  deployment_targets: DeploymentTargetsTable;
  deployment_target_servers: DeploymentTargetServersTable;
  service_environment_configs: ServiceEnvironmentConfigsTable;
  environment_variables: EnvironmentVariablesTable;
  service_environment_variables: ServiceEnvironmentVariablesTable;
  project_addresses: ProjectAddressesTable;
  project_dependencies: ProjectDependenciesTable;
  pipelines: PipelinesTable;
  pipeline_versions: PipelineVersionsTable;
  tasks: TasksTable;
  task_targets: TaskTargetsTable;
  task_steps: TaskStepsTable;
  pipeline_runs: PipelineRunsTable;
  registries: RegistriesTable;
  artifacts: ArtifactsTable;
  deployment_records: DeploymentRecordsTable;
  command_templates: CommandTemplatesTable;
  operation_plans: OperationPlansTable;
  operation_plan_versions: OperationPlanVersionsTable;
  ai_providers: AiProvidersTable;
  ai_permission_policies: AiPermissionPoliciesTable;
  ai_policy_rules: AiPolicyRulesTable;
  ai_action_proposals: AiActionProposalsTable;
  ai_conversations: AiConversationsTable;
  ai_messages: AiMessagesTable;
  views: ViewsTable;
  view_projects: ViewProjectsTable;
  audit_logs: AuditLogsTable;
}
