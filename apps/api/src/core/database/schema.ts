import type { Generated } from 'kysely';

/** Storage contract: UUID text IDs, UTC milliseconds, 0/1 flags and JSON text. */
export interface UsersTable {
  id: string;
  username: string;
  password_hash: string;
  must_change_password: Generated<number>;
  password_change_recommended: Generated<number>;
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
  automatic_execution_credential_nonce: Generated<string | null>;
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
  sort_order: Generated<number>;
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
  archived_at: Generated<number | null>;
  id: string;
  project_id: string;
  name: string;
  provider: Generated<string>;
  clone_url: string;
  credential_id: Generated<string | null>;
  default_branch: Generated<string>;
  branch_cache_json: Generated<string | null>;
  branch_checked_at: Generated<number | null>;
  branch_error: Generated<string | null>;
  branch_request_id: Generated<string | null>;
  description: Generated<string>;
  created_at: number;
  updated_at: number;
}

export interface ServicesTable {
  archived_at: Generated<number | null>;
  revision: Generated<number>;
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

export interface ServiceAddressesTable {
  id: string;
  service_id: string;
  name: string;
  url: string;
  position: number;
}

export interface ServiceRepositoriesTable {
  service_id: string;
  repository_id: string;
  repo_path: Generated<string>;
  role: Generated<string>;
  is_primary: Generated<number>;
}

export interface EnvironmentsTable {
  archived_at: Generated<number | null>;
  default_target_selection_json: Generated<string | null>;
  id: string;
  project_id: string;
  name: string;
  slug: string;
  environment_type: Generated<string>;
  repository_env_file: Generated<string | null>;
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
  execution_mode: Generated<'BUILD_ONLY' | 'DEPLOY' | null>;
  id: string;
  service_id: string;
  environment_id: string;
  target_id: Generated<string | null>;
  target_selection_json: Generated<string | null>;
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
  release_policy_json: Generated<string>;
  config_json: Generated<string>;
  created_at: number;
  updated_at: number;
}

export interface ServiceComposeTemplatesTable {
  id: string;
  service_id: string;
  environment_id: string;
  version: number;
  content: string | null;
  checksum: string | null;
  created_by: string;
  created_at: number;
}

interface VariablesTable {
  id: string;
  key: string;
  value_text: Generated<string | null>;
  credential_id: Generated<string | null>;
  is_secret: Generated<number>;
  description: Generated<string>;
  created_at: Generated<number>;
  updated_at: Generated<number>;
}

export interface ProjectVariablesTable extends VariablesTable {
  project_id: string;
}

export interface EnvironmentVariablesTable extends VariablesTable {
  environment_id: string;
}

export interface ProjectEnvironmentSetsTable {
  id: string;
  project_id: string;
  name: string;
  description: Generated<string>;
  revision: Generated<number>;
  archived_at: Generated<number | null>;
  created_at: number;
  updated_at: number;
}

export interface ProjectEnvironmentSetVariablesTable extends VariablesTable {
  environment_set_id: string;
}

export interface ServiceEnvironmentVariablesTable extends VariablesTable {
  service_id: string;
  environment_id: string;
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

export interface PipelineWebhooksTable {
  follow_mode: Generated<number>;
  confirmed_mode: Generated<'BUILD_ONLY' | 'DEPLOY'>;
  pipeline_id: string;
  pipeline_version: number;
  configuration_hash: string;
  environment_id: string;
  target_id: Generated<string | null>;
  target_selection_json: Generated<string | null>;
  secret_credential_id: string;
  created_by: string;
  branch: string;
  enabled: Generated<number>;
  repository_key: string;
  created_at: number;
  updated_at: number;
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
  release_approved_by: Generated<string | null>;
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
  target_id: Generated<string | null>;
  target_selection_json: Generated<string | null>;
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
  logical_artifact_id: Generated<string | null>;
  physical_json: Generated<string | null>;
  physical_key: Generated<string | null>;
  temporary_root_id: Generated<string | null>;
  environment_set_id: Generated<string | null>;
  lifecycle_state: Generated<string>;
  verification_status: Generated<string | null>;
  verification_reason: Generated<string | null>;
  verified_at: Generated<number | null>;
  verified_by: Generated<string | null>;
  source_manifest: Generated<number | null>;
  artifact_name: Generated<string | null>;
  artifact_kind: Generated<string | null>;
  graph_run_id: Generated<string | null>;
  graph_node_run_id: Generated<string | null>;
  pinned_at: Generated<number | null>;
  pruned_at: Generated<number | null>;
  archive_deleted_at: Generated<number | null>;
  archive_image_id: Generated<string | null>;
  archive_image_platform: Generated<string | null>;
  compose_yaml: Generated<string | null>;
  compose_checksum: Generated<string | null>;
  id: string;
  project_id: string;
  service_id: string;
  pipeline_run_id: Generated<string | null>;
  artifact_type: string;
  storage_type: string;
  storage_key: string;
  archive_key: Generated<string | null>;
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

export interface ArtifactSourcesTable {
  artifact_id: string;
  position: number;
  repository_id: string;
  commit_sha: string;
  git_ref: string | null;
  commit_subject: string | null;
  workspace_run_id: string | null;
  workspace_node_run_id: string | null;
  path: string | null;
}

export interface ArtifactCleanupJobsTable {
  id: string;
  request_key: string;
  request_hash: string;
  requested_by: string | null;
  authorized_by: string | null;
  created_at: number;
}

export interface ArtifactCleanupItemsTable {
  job_id: string;
  instance_id: string;
  artifact_id: string;
  group_key: string;
  action: 'REMOVE' | 'DETACH';
  status: 'PENDING' | 'RUNNING' | 'RETRY' | 'DELETED' | 'RETAINED';
  attempts: number;
  cycle_attempts: number;
  reason: string | null;
  available_at: number | null;
  lease_id: string | null;
  lease_until: number | null;
  updated_at: number;
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
  rollback_of_deployment_id: Generated<string | null>;
  release_snapshot_json: Generated<string | null>;
  compose_release_json: Generated<string | null>;
  release_scope_key: Generated<string | null>;
  release_path_key: Generated<string | null>;
  activated_at: Generated<number | null>;
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
  current_version: Generated<number>;
  enabled: Generated<number>;
  created_by: string;
  created_at: number;
}

export interface CommandTemplateVersionsTable {
  id: string;
  template_id: string;
  version: number;
  name: string;
  description: string;
  command_text: string;
  variables_schema_json: string;
  timeout_seconds: number;
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

export interface OperationSchedulesTable {
  id: string;
  name: string;
  owner_id: string;
  kind: string;
  source_id: string;
  source_version: number;
  config_json: string;
  approved_targets_json: string;
  status: string;
  status_reason: Generated<string | null>;
  next_run_at: Generated<number | null>;
  revision: Generated<number>;
  created_at: number;
  updated_at: number;
}

export interface OperationScheduleRunsTable {
  id: string;
  schedule_id: string;
  scheduled_at: number;
  triggered_at: number;
  status: string;
  reason: Generated<string | null>;
  task_id: Generated<string | null>;
  confirmation_expires_at: Generated<number | null>;
  missed_until: Generated<number | null>;
  snapshot_json: string;
}

export interface NotificationEventsTable {
  id: string;
  task_id: string;
  project_id: string;
  service_id: Generated<string | null>;
  environment_id: Generated<string | null>;
  stage: string;
  level: string;
  status: string;
  summary_json: string;
  created_at: number;
}

export interface UserNotificationsTable {
  id: string;
  event_id: string;
  user_id: string;
  read_at: Generated<number | null>;
  created_at: number;
}

export interface NotificationPreferencesTable {
  user_id: string;
  email: Generated<string | null>;
  email_enabled: Generated<number>;
  minimum_level: Generated<string>;
  verified_at: Generated<number | null>;
  verification_hash: Generated<string | null>;
  verification_expires_at: Generated<number | null>;
  verification_requested_at: Generated<number | null>;
  verification_attempts: Generated<number>;
}

export interface NotificationSubscriptionsTable {
  user_id: string;
  project_id: string;
  stage: string;
}

export interface NotificationMailTable {
  id: string;
  notification_id: string;
  status: string;
  attempts: Generated<number>;
  available_at: number;
  lease_id: Generated<string | null>;
  lease_expires_at: Generated<number | null>;
  sent_at: Generated<number | null>;
  error: Generated<string | null>;
}

export interface PipelineTriggersTable {
  id: string;
  pipeline_id: string;
  kind: 'SCHEDULE' | 'POLL';
  version: number;
  environment_id: string;
  branch: string;
  repository_id: string;
  owner_id: string;
  configuration_hash: string;
  timing_json: string;
  repository_hash: string;
  mode: 'BUILD_ONLY' | 'DEPLOY';
  target_json: string | null;
  build_current: number;
  baseline_sha: string | null;
  status: string;
  reason: string | null;
  next_at: number | null;
  anchor_at: number;
  lease_id: string | null;
  lease_until: number | null;
  failures: number;
}
export interface PipelineTriggerHistoryTable {
  id: string;
  pipeline_id: string;
  kind: string;
  status: string;
  version: number | null;
  environment_id: string | null;
  branch: string | null;
  commit_sha: string | null;
  mode: string | null;
  task_id: string | null;
  reason: string | null;
  scheduled_at: number | null;
  trigger_id: string | null;
  created_at: number;
}

export interface Database {
  execution_graph_triggers: {
    id: string;
    project_id: string;
    flow_id: string;
    version: number;
    name: string;
    kind: string;
    config_json: string;
    enabled: number;
    next_at: Generated<number | null>;
    source_checked_at: Generated<number | null>;
    source_error: Generated<string | null>;
    created_by: string;
    created_at: number;
    updated_at: number;
  };
  execution_graph_trigger_events: {
    id: string;
    trigger_id: string;
    event_key: string;
    request_hash: string;
    input_value: Generated<string | null>;
    graph_version: Generated<number | null>;
    flow_id: Generated<string | null>;
    rule_revision: Generated<string | null>;
    resolved_inputs: Generated<string | null>;
    status: string;
    run_id: Generated<string | null>;
    duplicate_of: Generated<string | null>;
    error: Generated<string | null>;
    created_at: number;
    finished_at: Generated<number | null>;
  };
  execution_graph_source_observations: {
    project_id: string;
    flow_id: string;
    repository_id: string;
    ref: string;
    commit_sha: string;
    sequence: number;
    event_id: Generated<string | null>;
    last_checked_at: number;
  };
  execution_graphs: {
    id: string;
    project_id: string;
    revision: number;
    draft_json: string;
    published_version: Generated<number | null>;
    created_at: number;
    updated_at: number;
  };
  execution_graph_versions: {
    retired_at: Generated<number | null>;
    id: string;
    graph_id: string;
    version: number;
    source_revision: number;
    definition_json: string;
    created_at: number;
    created_by: string;
  };
  execution_flow_runs: {
    id: string;
    graph_id: string;
    project_id: string;
    version: number;
    flow_id: string;
    flow_name: string;
    created_by: string;
    idempotency_key: string;
    request_hash: string;
    configuration_hash: string;
    inputs_json: string;
    status: string;
    created_at: number;
    finished_at: Generated<number | null>;
    parent_run_id: Generated<string | null>;
    trigger_type: Generated<string | null>;
    task_id: Generated<string | null>;
  };
  execution_node_runs: {
    id: string;
    run_id: string;
    node_id: string;
    name: string;
    node_type: string;
    position: number;
    status: string;
    log: string;
    started_at: Generated<number | null>;
    finished_at: Generated<number | null>;
    task_id: Generated<string | null>;
    child_run_id: Generated<string | null>;
    output_json: Generated<string | null>;
    dispatch_json: Generated<string | null>;
    evidence_json: Generated<string | null>;
  };
  monitor_settings: {
    id: number;
    enabled: number;
    interval_seconds: number;
    retention_days: number;
    concurrency: number;
  };
  monitor_hosts: {
    server_id: string;
    enabled: number;
    interface_name: string | null;
    next_at: number;
    lease: string | null;
    lease_until: number;
    failures: number;
    attempt_at: number | null;
    sampled_at: number | null;
    raw_json: string | null;
    metrics_json: string | null;
    error: string | null;
  };
  monitor_samples: {
    id: string;
    server_id: string;
    at: number;
    raw_json: string | null;
    metrics_json: string | null;
  };
  ai_failure_settings: {
    service_id: string;
    environment_id: string;
    revision: string;
    enabled: number;
    component: 'docker' | 'compose' | 'node' | 'nginx' | null;
  };
  ai_failure_incidents: {
    task_id: string;
    service_id: string;
    environment_id: string;
    revision: string;
    status:
      | 'PENDING'
      | 'DIAGNOSING'
      | 'ADVICE'
      | 'AWAITING_APPROVAL'
      | 'REPAIRING'
      | 'VERIFIED'
      | 'MANUAL';
    summary: string;
    findings_json: Generated<string>;
    proposal_id: Generated<string | null>;
    repair_task_id: Generated<string | null>;
    created_at: number;
    updated_at: number;
  };
  pipeline_triggers: PipelineTriggersTable;
  pipeline_trigger_history: PipelineTriggerHistoryTable;
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
  service_addresses: ServiceAddressesTable;
  service_repositories: ServiceRepositoriesTable;
  environments: EnvironmentsTable;
  deployment_targets: DeploymentTargetsTable;
  deployment_target_servers: DeploymentTargetServersTable;
  service_environment_configs: ServiceEnvironmentConfigsTable;
  service_compose_templates: ServiceComposeTemplatesTable;
  service_source_reviews: {
    id: string;
    project_id: string;
    service_id: string;
    environment_id: string;
    commit_sha: string;
    decision: 'APPROVED' | 'REVOKED';
    reason: string | null;
    reviewed_by: string;
    created_at: number;
    updated_at: number;
  };
  repository_source_reviews: {
    id: string;
    project_id: string;
    service_id: string;
    environment_id: string;
    repository_id: string;
    commit_sha: string;
    decision: 'APPROVED' | 'REVOKED';
    reason: string | null;
    reviewed_by: string;
    created_at: number;
    updated_at: number;
  };
  project_variables: ProjectVariablesTable;
  project_environment_sets: ProjectEnvironmentSetsTable;
  project_environment_set_variables: ProjectEnvironmentSetVariablesTable;
  environment_variables: EnvironmentVariablesTable;
  service_environment_variables: ServiceEnvironmentVariablesTable;
  project_addresses: ProjectAddressesTable;
  pipelines: PipelinesTable;
  pipeline_versions: PipelineVersionsTable;
  pipeline_webhooks: PipelineWebhooksTable;
  tasks: TasksTable;
  task_targets: TaskTargetsTable;
  task_steps: TaskStepsTable;
  pipeline_runs: PipelineRunsTable;
  registries: RegistriesTable;
  artifacts: ArtifactsTable;
  artifact_cleanup_jobs: ArtifactCleanupJobsTable;
  artifact_cleanup_items: ArtifactCleanupItemsTable;
  artifact_sources: ArtifactSourcesTable;
  deployment_records: DeploymentRecordsTable;
  command_templates: CommandTemplatesTable;
  command_template_versions: CommandTemplateVersionsTable;
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
  operation_schedules: OperationSchedulesTable;
  operation_schedule_runs: OperationScheduleRunsTable;
  notification_events: NotificationEventsTable;
  user_notifications: UserNotificationsTable;
  notification_preferences: NotificationPreferencesTable;
  notification_subscriptions: NotificationSubscriptionsTable;
  notification_mail: NotificationMailTable;
}
