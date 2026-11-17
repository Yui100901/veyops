import {
  sql,
  type Kysely,
  type Migration,
  type MigrationProvider,
  type CreateTableBuilder,
} from 'kysely';

interface ColumnOptions {
  nullable?: boolean;
  primaryKey?: boolean;
  default?: string | number;
  references?: string;
  onDelete?: 'restrict' | 'cascade';
}
type Column = readonly [string, 'text' | 'integer' | 'bigint', ColumnOptions?];
interface TableDefinition {
  name: string;
  columns: readonly Column[];
  primaryKey?: string[];
  unique?: string[][];
  checks?: string[];
}

// Every schema change after this migration must use a new version; never mutate production history.
const tables: TableDefinition[] = [
  {
    name: 'users',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['username', 'text'],
      ['password_hash', 'text'],
      ['role', 'text', { default: 'VIEWER' }],
      ['status', 'text', { default: 'ACTIVE' }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    unique: [['username']],
    checks: ["role IN ('ADMIN', 'OPERATOR', 'VIEWER')", "status IN ('ACTIVE', 'DISABLED')"],
  },
  {
    name: 'auth_sessions',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['user_id', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['token_hash', 'text'],
      ['expires_at', 'bigint'],
      ['revoked_at', 'bigint', { nullable: true }],
      ['created_at', 'bigint'],
    ],
    unique: [['token_hash']],
  },
  {
    name: 'system_settings',
    columns: [
      ['key', 'text', { primaryKey: true }],
      ['value_json', 'text'],
      ['updated_at', 'bigint'],
    ],
  },
  {
    name: 'credentials',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['type', 'text'],
      ['ciphertext', 'text'],
      ['nonce', 'text'],
      ['auth_tag', 'text'],
      ['key_version', 'text', { default: 'v1' }],
      ['metadata_json', 'text', { default: '{}' }],
      ['status', 'text', { default: 'ACTIVE' }],
      ['created_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    checks: ["status IN ('ACTIVE', 'DISABLED')"],
  },
  {
    name: 'servers',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['host', 'text'],
      ['port', 'integer', { default: 22 }],
      ['username', 'text'],
      [
        'credential_id',
        'text',
        { nullable: true, references: 'credentials.id', onDelete: 'restrict' },
      ],
      ['os_type', 'text', { nullable: true }],
      ['host_key_fingerprint', 'text', { nullable: true }],
      ['status', 'text', { default: 'UNKNOWN' }],
      ['last_checked_at', 'bigint', { nullable: true }],
      ['tags_json', 'text', { default: '[]' }],
      ['is_active', 'integer', { default: 1 }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
      ['description', 'text', { default: '' }],
    ],
    checks: ['port >= 1 AND port <= 65535', 'is_active IN (0, 1)'],
  },
  {
    name: 'server_groups',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['description', 'text', { default: '' }],
      ['created_at', 'bigint'],
    ],
  },
  {
    name: 'server_group_members',
    columns: [
      ['group_id', 'text', { references: 'server_groups.id', onDelete: 'cascade' }],
      ['server_id', 'text', { references: 'servers.id', onDelete: 'cascade' }],
      ['created_at', 'bigint'],
    ],
    primaryKey: ['group_id', 'server_id'],
  },
  {
    name: 'projects',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['slug', 'text'],
      ['description', 'text', { default: '' }],
      ['icon', 'text', { default: '' }],
      ['tags_json', 'text', { default: '[]' }],
      ['status', 'text', { default: 'ACTIVE' }],
      ['created_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['deleted_at', 'bigint', { nullable: true }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    unique: [['slug']],
  },
  {
    name: 'repositories',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['project_id', 'text', { references: 'projects.id', onDelete: 'restrict' }],
      ['name', 'text'],
      ['provider', 'text', { default: 'CUSTOM' }],
      ['clone_url', 'text'],
      [
        'credential_id',
        'text',
        { nullable: true, references: 'credentials.id', onDelete: 'restrict' },
      ],
      ['default_branch', 'text', { default: 'main' }],
      ['description', 'text', { default: '' }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
  },
  {
    name: 'services',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['project_id', 'text', { references: 'projects.id', onDelete: 'restrict' }],
      ['name', 'text'],
      ['slug', 'text'],
      ['service_type', 'text', { default: 'API' }],
      ['description', 'text', { default: '' }],
      ['default_build_config_json', 'text', { default: '{}' }],
      ['default_deploy_config_json', 'text', { default: '{}' }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    unique: [['project_id', 'slug']],
  },
  {
    name: 'service_repositories',
    columns: [
      ['service_id', 'text', { references: 'services.id', onDelete: 'cascade' }],
      ['repository_id', 'text', { references: 'repositories.id', onDelete: 'cascade' }],
      ['repo_path', 'text', { default: '.' }],
      ['role', 'text', { default: 'SOURCE' }],
      ['is_primary', 'integer', { default: 0 }],
    ],
    primaryKey: ['service_id', 'repository_id'],
    checks: ['is_primary IN (0, 1)'],
  },
  {
    name: 'environments',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['project_id', 'text', { references: 'projects.id', onDelete: 'restrict' }],
      ['name', 'text'],
      ['slug', 'text'],
      ['environment_type', 'text', { default: 'CUSTOM' }],
      ['description', 'text', { default: '' }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    unique: [['project_id', 'slug']],
  },
  {
    name: 'deployment_targets',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['description', 'text', { default: '' }],
      ['strategy', 'text', { default: 'PARALLEL' }],
      ['max_parallel', 'integer', { default: 3 }],
      ['failure_policy', 'text', { default: 'CONTINUE' }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    checks: [
      "strategy IN ('PARALLEL', 'SEQUENTIAL')",
      'max_parallel >= 1 AND max_parallel <= 32',
      "failure_policy IN ('STOP', 'CONTINUE')",
    ],
  },
  {
    name: 'deployment_target_servers',
    columns: [
      ['target_id', 'text', { references: 'deployment_targets.id', onDelete: 'cascade' }],
      ['server_id', 'text', { references: 'servers.id', onDelete: 'cascade' }],
      ['sort_order', 'integer', { default: 0 }],
    ],
    primaryKey: ['target_id', 'server_id'],
  },
  {
    name: 'service_environment_configs',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['service_id', 'text', { references: 'services.id', onDelete: 'restrict' }],
      ['environment_id', 'text', { references: 'environments.id', onDelete: 'restrict' }],
      [
        'target_id',
        'text',
        { nullable: true, references: 'deployment_targets.id', onDelete: 'restrict' },
      ],
      ['build_location', 'text', { nullable: true }],
      ['artifact_type', 'text', { default: 'FILE' }],
      ['deploy_method', 'text', { default: 'FILE' }],
      ['working_directory', 'text', { default: '' }],
      ['build_command', 'text', { default: '' }],
      ['build_output_path', 'text', { default: '' }],
      ['dockerfile_path', 'text', { default: '' }],
      ['docker_context', 'text', { default: '' }],
      ['deploy_path', 'text', { default: '' }],
      ['compose_file_path', 'text', { default: '' }],
      ['compose_project_name', 'text', { default: '' }],
      ['start_command', 'text', { default: '' }],
      ['stop_command', 'text', { default: '' }],
      ['restart_command', 'text', { default: '' }],
      ['health_check_json', 'text', { default: '{}' }],
      ['config_json', 'text', { default: '{}' }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    unique: [['service_id', 'environment_id']],
    checks: [
      "build_location IS NULL OR build_location IN ('TARGET', 'MANAGER')",
      "artifact_type IN ('FILE', 'DOCKER_IMAGE')",
      "deploy_method IN ('FILE', 'DOCKER_COMPOSE')",
    ],
  },
  {
    name: 'environment_variables',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['environment_id', 'text', { references: 'environments.id', onDelete: 'restrict' }],
      ['key', 'text'],
      ['value_text', 'text', { nullable: true }],
      [
        'credential_id',
        'text',
        { nullable: true, references: 'credentials.id', onDelete: 'restrict' },
      ],
      ['is_secret', 'integer', { default: 0 }],
    ],
    unique: [['environment_id', 'key']],
    checks: [
      '(is_secret = 0 AND value_text IS NOT NULL AND credential_id IS NULL) OR (is_secret = 1 AND value_text IS NULL AND credential_id IS NOT NULL)',
    ],
  },
  {
    name: 'service_environment_variables',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['config_id', 'text', { references: 'service_environment_configs.id', onDelete: 'restrict' }],
      ['key', 'text'],
      ['value_text', 'text', { nullable: true }],
      [
        'credential_id',
        'text',
        { nullable: true, references: 'credentials.id', onDelete: 'restrict' },
      ],
      ['is_secret', 'integer', { default: 0 }],
    ],
    unique: [['config_id', 'key']],
    checks: [
      '(is_secret = 0 AND value_text IS NOT NULL AND credential_id IS NULL) OR (is_secret = 1 AND value_text IS NULL AND credential_id IS NOT NULL)',
    ],
  },
  {
    name: 'project_addresses',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['project_id', 'text', { references: 'projects.id', onDelete: 'restrict' }],
      ['service_id', 'text', { nullable: true, references: 'services.id', onDelete: 'restrict' }],
      [
        'environment_id',
        'text',
        { nullable: true, references: 'environments.id', onDelete: 'restrict' },
      ],
      ['name', 'text'],
      ['url', 'text'],
      ['address_type', 'text', { default: 'WEB' }],
      ['visibility', 'text', { default: 'INTERNAL' }],
      ['description', 'text', { default: '' }],
    ],
  },
  {
    name: 'project_dependencies',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['project_id', 'text', { references: 'projects.id', onDelete: 'restrict' }],
      ['depends_on_project_id', 'text', { references: 'projects.id', onDelete: 'restrict' }],
      ['dependency_type', 'text', { default: 'RUNTIME' }],
      ['description', 'text', { default: '' }],
    ],
    unique: [['project_id', 'depends_on_project_id', 'dependency_type']],
    checks: ['project_id <> depends_on_project_id'],
  },
  {
    name: 'pipelines',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['project_id', 'text', { references: 'projects.id', onDelete: 'restrict' }],
      ['service_id', 'text', { references: 'services.id', onDelete: 'restrict' }],
      ['name', 'text'],
      ['enabled', 'integer', { default: 1 }],
      ['current_version', 'integer', { default: 1 }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    checks: ['enabled IN (0, 1)', 'current_version >= 1'],
  },
  {
    name: 'pipeline_versions',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['pipeline_id', 'text', { references: 'pipelines.id', onDelete: 'restrict' }],
      ['version', 'integer'],
      ['schema_version', 'integer', { default: 1 }],
      ['definition_json', 'text'],
      ['created_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['created_at', 'bigint'],
    ],
    unique: [['pipeline_id', 'version']],
    checks: ['version >= 1'],
  },
  {
    name: 'operation_plans',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['description', 'text', { default: '' }],
      ['category', 'text', { default: 'CUSTOM' }],
      ['enabled', 'integer', { default: 1 }],
      ['current_version', 'integer', { default: 1 }],
      ['created_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    checks: ['enabled IN (0, 1)', 'current_version >= 1'],
  },
  {
    name: 'operation_plan_versions',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['plan_id', 'text', { references: 'operation_plans.id', onDelete: 'restrict' }],
      ['version', 'integer'],
      ['schema_version', 'integer', { default: 1 }],
      ['definition_json', 'text'],
      ['created_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['created_at', 'bigint'],
    ],
    unique: [['plan_id', 'version']],
    checks: ['version >= 1'],
  },
  {
    name: 'tasks',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['task_type', 'text'],
      ['status', 'text', { default: 'PENDING' }],
      ['origin', 'text', { default: 'USER' }],
      ['priority', 'integer', { default: 0 }],
      ['created_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['project_id', 'text', { nullable: true, references: 'projects.id', onDelete: 'restrict' }],
      ['service_id', 'text', { nullable: true, references: 'services.id', onDelete: 'restrict' }],
      [
        'environment_id',
        'text',
        { nullable: true, references: 'environments.id', onDelete: 'restrict' },
      ],
      [
        'target_id',
        'text',
        { nullable: true, references: 'deployment_targets.id', onDelete: 'restrict' },
      ],
      [
        'operation_plan_version_id',
        'text',
        { nullable: true, references: 'operation_plan_versions.id', onDelete: 'restrict' },
      ],
      ['payload_json', 'text'],
      ['result_json', 'text', { nullable: true }],
      ['idempotency_key', 'text', { nullable: true }],
      ['attempt_count', 'integer', { default: 0 }],
      ['max_attempts', 'integer', { default: 1 }],
      ['available_at', 'bigint', { default: 0 }],
      ['lease_owner', 'text', { nullable: true }],
      ['lease_expires_at', 'bigint', { nullable: true }],
      ['heartbeat_at', 'bigint', { nullable: true }],
      ['cancel_requested_at', 'bigint', { nullable: true }],
      ['started_at', 'bigint', { nullable: true }],
      ['finished_at', 'bigint', { nullable: true }],
      ['log_file_key', 'text', { nullable: true }],
      ['log_size_bytes', 'bigint', { default: 0 }],
      ['error_summary', 'text', { nullable: true }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
      ['name', 'text', { default: '' }],
    ],
    unique: [['idempotency_key']],
  },
  {
    name: 'task_targets',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['task_id', 'text', { references: 'tasks.id', onDelete: 'restrict' }],
      ['server_id', 'text', { nullable: true, references: 'servers.id', onDelete: 'restrict' }],
      ['server_name_snapshot', 'text'],
      ['host_snapshot', 'text'],
      ['status', 'text', { default: 'PENDING' }],
      ['exit_code', 'integer', { nullable: true }],
      ['result_json', 'text', { nullable: true }],
      ['started_at', 'bigint', { nullable: true }],
      ['finished_at', 'bigint', { nullable: true }],
      ['error_summary', 'text', { nullable: true }],
      ['port_snapshot', 'integer', { default: 22 }],
      ['username_snapshot', 'text', { default: '' }],
      [
        'credential_id_snapshot',
        'text',
        { nullable: true, references: 'credentials.id', onDelete: 'restrict' },
      ],
      ['fingerprint_snapshot', 'text', { nullable: true }],
    ],
  },
  {
    name: 'task_steps',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['task_id', 'text', { references: 'tasks.id', onDelete: 'restrict' }],
      [
        'task_target_id',
        'text',
        { nullable: true, references: 'task_targets.id', onDelete: 'restrict' },
      ],
      ['execution_target_key', 'text'],
      ['step_key', 'text'],
      ['step_order', 'integer'],
      ['step_type', 'text'],
      ['status', 'text', { default: 'PENDING' }],
      ['input_json', 'text', { default: '{}' }],
      ['result_json', 'text', { nullable: true }],
      ['exit_code', 'integer', { nullable: true }],
      ['started_at', 'bigint', { nullable: true }],
      ['finished_at', 'bigint', { nullable: true }],
    ],
    unique: [['task_id', 'execution_target_key', 'step_key']],
  },
  {
    name: 'pipeline_runs',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['task_id', 'text', { references: 'tasks.id', onDelete: 'restrict' }],
      ['pipeline_id', 'text', { references: 'pipelines.id', onDelete: 'restrict' }],
      ['pipeline_version_id', 'text', { references: 'pipeline_versions.id', onDelete: 'restrict' }],
      ['project_id', 'text', { references: 'projects.id', onDelete: 'restrict' }],
      ['service_id', 'text', { references: 'services.id', onDelete: 'restrict' }],
      ['environment_id', 'text', { references: 'environments.id', onDelete: 'restrict' }],
      ['target_id', 'text', { references: 'deployment_targets.id', onDelete: 'restrict' }],
      ['git_ref', 'text'],
      ['commit_sha', 'text'],
      ['build_location_snapshot', 'text'],
      ['artifact_type_snapshot', 'text'],
      ['trigger_type', 'text', { default: 'MANUAL' }],
      ['created_at', 'bigint'],
    ],
    unique: [['task_id']],
  },
  {
    name: 'registries',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['registry_url', 'text'],
      [
        'credential_id',
        'text',
        { nullable: true, references: 'credentials.id', onDelete: 'restrict' },
      ],
      ['created_at', 'bigint'],
    ],
  },
  {
    name: 'artifacts',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['project_id', 'text', { references: 'projects.id', onDelete: 'restrict' }],
      ['service_id', 'text', { references: 'services.id', onDelete: 'restrict' }],
      [
        'pipeline_run_id',
        'text',
        { nullable: true, references: 'pipeline_runs.id', onDelete: 'restrict' },
      ],
      ['artifact_type', 'text'],
      ['storage_type', 'text'],
      ['storage_key', 'text'],
      ['server_id', 'text', { nullable: true, references: 'servers.id', onDelete: 'restrict' }],
      [
        'registry_id',
        'text',
        { nullable: true, references: 'registries.id', onDelete: 'restrict' },
      ],
      ['image_repository', 'text', { nullable: true }],
      ['image_tag', 'text', { nullable: true }],
      ['image_digest', 'text', { nullable: true }],
      ['checksum', 'text', { nullable: true }],
      ['size_bytes', 'bigint', { nullable: true }],
      ['source_commit', 'text', { nullable: true }],
      ['created_at', 'bigint'],
    ],
  },
  {
    name: 'deployment_records',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['pipeline_run_id', 'text', { references: 'pipeline_runs.id', onDelete: 'restrict' }],
      ['artifact_id', 'text', { nullable: true, references: 'artifacts.id', onDelete: 'restrict' }],
      ['task_target_id', 'text', { references: 'task_targets.id', onDelete: 'restrict' }],
      ['service_id', 'text', { references: 'services.id', onDelete: 'restrict' }],
      ['environment_id', 'text', { references: 'environments.id', onDelete: 'restrict' }],
      ['server_id', 'text', { nullable: true, references: 'servers.id', onDelete: 'restrict' }],
      ['status', 'text'],
      ['release_version', 'text', { nullable: true }],
      ['deploy_path', 'text', { nullable: true }],
      ['health_status', 'text', { nullable: true }],
      [
        'previous_deployment_id',
        'text',
        { nullable: true, references: 'deployment_records.id', onDelete: 'restrict' },
      ],
      ['started_at', 'bigint', { nullable: true }],
      ['finished_at', 'bigint', { nullable: true }],
    ],
  },
  {
    name: 'command_templates',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['description', 'text', { default: '' }],
      ['command_text', 'text'],
      ['shell_type', 'text', { default: 'sh' }],
      ['variables_schema_json', 'text', { default: '{}' }],
      ['risk_level', 'text', { default: 'UNKNOWN' }],
      ['timeout_seconds', 'integer', { default: 300 }],
      ['created_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['created_at', 'bigint'],
    ],
  },
  {
    name: 'ai_providers',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['base_url', 'text'],
      ['model', 'text'],
      [
        'credential_id',
        'text',
        { nullable: true, references: 'credentials.id', onDelete: 'restrict' },
      ],
      ['timeout_seconds', 'integer', { default: 60 }],
      ['enabled', 'integer', { default: 1 }],
      ['created_at', 'bigint'],
    ],
    checks: ['enabled IN (0, 1)'],
  },
  {
    name: 'ai_permission_policies',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['scope_type', 'text'],
      ['scope_key', 'text'],
      ['project_id', 'text', { nullable: true, references: 'projects.id', onDelete: 'restrict' }],
      ['mode', 'text', { default: 'CONFIRM' }],
      ['scope_json', 'text', { default: '{}' }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    unique: [['scope_key']],
    checks: [
      "mode IN ('READ_ONLY', 'CONFIRM', 'FULL_CONTROL')",
      "(scope_type = 'SYSTEM' AND scope_key = 'system' AND project_id IS NULL) OR (scope_type = 'PROJECT' AND project_id IS NOT NULL AND scope_key = 'project:' || project_id)",
    ],
  },
  {
    name: 'ai_policy_rules',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['policy_id', 'text', { references: 'ai_permission_policies.id', onDelete: 'restrict' }],
      ['action_category', 'text'],
      ['effect', 'text'],
      ['target_type', 'text', { default: 'ANY' }],
      ['target_id', 'text', { nullable: true }],
      ['conditions_json', 'text', { default: '{}' }],
      ['created_at', 'bigint'],
    ],
    checks: ["effect IN ('ALLOW', 'DENY', 'REQUIRE_CONFIRM')"],
  },
  {
    name: 'ai_action_proposals',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['created_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['action_type', 'text'],
      ['payload_json', 'text'],
      ['preview_json', 'text'],
      ['risk_level', 'text'],
      ['policy_snapshot_json', 'text', { nullable: true }],
      ['status', 'text', { default: 'PENDING' }],
      ['expires_at', 'bigint'],
      ['confirmed_by', 'text', { nullable: true, references: 'users.id', onDelete: 'restrict' }],
      ['confirmed_at', 'bigint', { nullable: true }],
      ['task_id', 'text', { nullable: true, references: 'tasks.id', onDelete: 'restrict' }],
      ['created_at', 'bigint'],
    ],
  },
  {
    name: 'ai_conversations',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['user_id', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['title', 'text'],
      ['project_id', 'text', { nullable: true, references: 'projects.id', onDelete: 'restrict' }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
  },
  {
    name: 'ai_messages',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['conversation_id', 'text', { references: 'ai_conversations.id', onDelete: 'restrict' }],
      ['role', 'text'],
      ['content_json', 'text'],
      ['tool_call_json', 'text', { nullable: true }],
      ['created_at', 'bigint'],
    ],
  },
  {
    name: 'views',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['description', 'text', { default: '' }],
      ['created_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
      ['is_default', 'integer', { default: 0 }],
      ['created_at', 'bigint'],
    ],
    checks: ['is_default IN (0, 1)'],
  },
  {
    name: 'view_projects',
    columns: [
      ['view_id', 'text', { references: 'views.id', onDelete: 'cascade' }],
      ['project_id', 'text', { references: 'projects.id', onDelete: 'cascade' }],
      ['sort_order', 'integer', { default: 0 }],
    ],
    primaryKey: ['view_id', 'project_id'],
  },
  {
    name: 'audit_logs',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['actor_type', 'text'],
      ['user_id', 'text', { nullable: true, references: 'users.id', onDelete: 'restrict' }],
      ['action', 'text'],
      ['resource_type', 'text'],
      ['resource_id', 'text', { nullable: true }],
      ['request_id', 'text', { nullable: true }],
      ['details_json', 'text', { default: '{}' }],
      ['created_at', 'bigint'],
    ],
  },
];

const indexes: readonly (readonly [string, string[]])[] = [
  ['auth_sessions', ['expires_at']],
  ['servers', ['host', 'port']],
  ['repositories', ['project_id']],
  ['deployment_targets', ['name']],
  ['pipelines', ['project_id', 'service_id']],
  ['tasks', ['status', 'available_at', 'priority']],
  ['tasks', ['created_at']],
  ['tasks', ['lease_expires_at']],
  ['task_targets', ['task_id', 'status']],
  ['artifacts', ['service_id', 'created_at']],
  ['deployment_records', ['server_id', 'started_at']],
  ['deployment_records', ['service_id', 'environment_id', 'started_at']],
  ['ai_messages', ['conversation_id', 'created_at']],
  ['audit_logs', ['resource_type', 'resource_id', 'created_at']],
];

async function up(db: Kysely<unknown>): Promise<void> {
  for (const definition of tables) {
    let table: CreateTableBuilder<string, string> = db.schema.createTable(definition.name);
    for (const [name, type, options = {}] of definition.columns) {
      table = table.addColumn(name, type, (column) => {
        let result = column;
        if (options.primaryKey) result = result.primaryKey();
        if (!options.nullable) result = result.notNull();
        if (options.default !== undefined) result = result.defaultTo(options.default);
        if (options.references) {
          result = result.references(options.references).onDelete(options.onDelete ?? 'restrict');
        }
        return result;
      });
    }
    if (definition.primaryKey) {
      table = table.addPrimaryKeyConstraint(`${definition.name}_pk`, definition.primaryKey);
    }
    for (const [index, columns] of (definition.unique ?? []).entries()) {
      table = table.addUniqueConstraint(`${definition.name}_uq_${index}`, columns);
    }
    for (const [index, expression] of (definition.checks ?? []).entries()) {
      table = table.addCheckConstraint(`${definition.name}_ck_${index}`, sql.raw(expression));
    }
    await table.execute();
  }
  for (const [table, columns] of indexes) {
    await db.schema
      .createIndex(`${table}_${columns.join('_')}_idx`)
      .on(table)
      .columns(columns)
      .execute();
  }
}

async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...tables].reverse()) {
    await db.schema.dropTable(table.name).execute();
  }
}

export const initialMigration: Migration = { up, down };

export const administratorPasswordMigration: Migration = {
  async up(db) {
    await db.schema
      .alterTable('users')
      .addColumn('must_change_password', 'integer', (column) =>
        column
          .notNull()
          .defaultTo(0)
          .check(sql`must_change_password in (0, 1)`),
      )
      .execute();
  },
  async down(db) {
    await db.schema.alterTable('users').dropColumn('must_change_password').execute();
  },
};

export const pipelineWebhookMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable('pipeline_webhooks')
      .addColumn('pipeline_id', 'text', (c) =>
        c.primaryKey().references('pipelines.id').onDelete('cascade'),
      )
      .addColumn('pipeline_version', 'integer', (c) => c.notNull())
      .addColumn('configuration_hash', 'text', (c) => c.notNull())
      .addColumn('environment_id', 'text', (c) => c.notNull().references('environments.id'))
      .addColumn('target_id', 'text', (c) => c.notNull().references('deployment_targets.id'))
      .addColumn('secret_credential_id', 'text', (c) => c.notNull().references('credentials.id'))
      .addColumn('created_by', 'text', (c) => c.notNull().references('users.id'))
      .addColumn('branch', 'text', (c) => c.notNull())
      .addColumn('repository_key', 'text', (c) => c.notNull())
      .addColumn('enabled', 'integer', (c) =>
        c
          .notNull()
          .defaultTo(1)
          .check(sql`enabled in (0, 1)`),
      )
      .addColumn('created_at', 'bigint', (c) => c.notNull())
      .addColumn('updated_at', 'bigint', (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable('pipeline_webhooks').execute();
  },
};

export const artifactArchiveMigration: Migration = {
  async up(db) {
    await db.schema.alterTable('artifacts').addColumn('archive_key', 'text').execute();
  },
  async down(db) {
    await db.schema.alterTable('artifacts').dropColumn('archive_key').execute();
  },
};

export const batchOperationsMigration: Migration = {
  async up(db) {
    await db.schema
      .alterTable('command_templates')
      .addColumn('current_version', 'integer', (c) =>
        c
          .notNull()
          .defaultTo(1)
          .check(sql`current_version >= 1`),
      )
      .execute();
    await db.schema
      .alterTable('command_templates')
      .addColumn('enabled', 'integer', (c) =>
        c
          .notNull()
          .defaultTo(1)
          .check(sql`enabled in (0, 1)`),
      )
      .execute();
    await db.schema
      .createTable('command_template_versions')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('template_id', 'text', (c) => c.notNull().references('command_templates.id'))
      .addColumn('version', 'integer', (c) => c.notNull().check(sql`version >= 1`))
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('description', 'text', (c) => c.notNull())
      .addColumn('command_text', 'text', (c) => c.notNull())
      .addColumn('variables_schema_json', 'text', (c) => c.notNull())
      .addColumn('timeout_seconds', 'integer', (c) => c.notNull())
      .addColumn('created_by', 'text', (c) => c.notNull().references('users.id'))
      .addColumn('created_at', 'bigint', (c) => c.notNull())
      .addUniqueConstraint('command_template_version_unique', ['template_id', 'version'])
      .execute();
    await sql`
      insert into command_template_versions (
        id, template_id, version, name, description, command_text,
        variables_schema_json, timeout_seconds, created_by, created_at
      )
      select id, id, 1, name, description, command_text,
        variables_schema_json, timeout_seconds, created_by, created_at
      from command_templates
    `.execute(db);
  },
  async down(db) {
    await db.schema.dropTable('command_template_versions').execute();
    await db.schema.alterTable('command_templates').dropColumn('enabled').execute();
    await db.schema.alterTable('command_templates').dropColumn('current_version').execute();
  },
};

export const artifactDeploymentMigration: Migration = {
  async up(db) {
    await db.schema.alterTable('artifacts').addColumn('compose_yaml', 'text').execute();
    await db.schema.alterTable('artifacts').addColumn('compose_checksum', 'text').execute();
  },
  async down(db) {
    // V1.0 treats unknown pipeline modes as legacy deploy runs.
    const splitTask = sql<boolean>`(payload_json like '%"mode":"DEPLOY_ARTIFACT"%' or payload_json like '%"deployAfterBuild":true%')`;
    const active = await db
      .selectFrom('tasks')
      .select('id')
      .where('task_type', '=', 'PIPELINE')
      .where(splitTask)
      .where('status', 'in', ['RUNNING', 'CANCEL_REQUESTED'])
      .executeTakeFirst();
    if (active) throw new Error('仍有执行中的拆分交付任务，请完成或核查后再降级');
    const now = Date.now();
    const cancelled = await db
      .updateTable('tasks')
      .set({ status: 'CANCELLED', updated_at: now, finished_at: now, error_summary: '拆分交付任务已随数据库降级取消' })
      .where('task_type', '=', 'PIPELINE')
      .where(splitTask)
      .where('status', '=', 'PENDING')
      .returning('id')
      .execute();
    for (const task of cancelled) {
      await db.updateTable('task_targets').set({ status: 'CANCELLED', finished_at: now })
        .where('task_id', '=', task.id).where('status', '=', 'PENDING').execute();
    }
    await db.schema.alterTable('artifacts').dropColumn('compose_checksum').execute();
    await db.schema.alterTable('artifacts').dropColumn('compose_yaml').execute();
  },
};

export const artifactRetentionMigration: Migration = {
  async up(db) {
    await db.schema.alterTable('artifacts').addColumn('pinned_at', 'bigint').execute();
    await db.schema.alterTable('artifacts').addColumn('pruned_at', 'bigint').execute();
    await db.schema.alterTable('artifacts').addColumn('archive_deleted_at', 'bigint').execute();
  },
  async down(db) {
    await db.schema.alterTable('artifacts').dropColumn('archive_deleted_at').execute();
    await db.schema.alterTable('artifacts').dropColumn('pruned_at').execute();
    await db.schema.alterTable('artifacts').dropColumn('pinned_at').execute();
  },
};

export const releaseProtectionMigration: Migration = {
  async up(db) {
    await db.schema.alterTable('service_environment_configs')
      .addColumn('release_policy_json', 'text', (column) => column.notNull().defaultTo('{}'))
      .execute();
    await db.schema.alterTable('deployment_records').addColumn('release_snapshot_json', 'text').execute();
    await db.schema.alterTable('deployment_records').addColumn('rollback_of_deployment_id', 'text').execute();
    await db.schema.alterTable('deployment_records').addColumn('activated_at', 'bigint').execute();
    await db.schema.alterTable('tasks').addColumn('release_approved_by', 'text').execute();
  },
  async down(db) {
    // A downgraded Worker must never run tasks that were waiting for approval.
    await db.updateTable('tasks').set({
      status: 'CANCELLED',
      finished_at: Date.now(),
      error_summary: '发布审批已随数据库降级取消',
    }).where('status', '=', 'PENDING').where('available_at', '=', Number.MAX_SAFE_INTEGER).execute();
    await db.schema.alterTable('tasks').dropColumn('release_approved_by').execute();
    await db.schema.alterTable('deployment_records').dropColumn('activated_at').execute();
    await db.schema.alterTable('deployment_records').dropColumn('rollback_of_deployment_id').execute();
    await db.schema.alterTable('deployment_records').dropColumn('release_snapshot_json').execute();
    await db.schema.alterTable('service_environment_configs').dropColumn('release_policy_json').execute();
  },
};

export const pushedImageArchivesMigration: Migration = {
  async up(db) {
    await db.schema.alterTable('artifacts').addColumn('archive_image_id', 'text').execute();
    await db.schema.alterTable('artifacts').addColumn('archive_image_platform', 'text').execute();
  },
  async down(db) {
    await db.schema.alterTable('artifacts').dropColumn('archive_image_platform').execute();
    await db.schema.alterTable('artifacts').dropColumn('archive_image_id').execute();
  },
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return {
      '001_initial': initialMigration,
      '002_administrator_password': administratorPasswordMigration,
      '003_pipeline_webhooks': pipelineWebhookMigration,
      '004_artifact_archives': artifactArchiveMigration,
      '005_batch_operations': batchOperationsMigration,
      '006_artifact_deployment': artifactDeploymentMigration,
      '007_release_protection': releaseProtectionMigration,
      '008_artifact_retention': artifactRetentionMigration,
      '009_pushed_image_archives': pushedImageArchivesMigration,
    };
  },
};
