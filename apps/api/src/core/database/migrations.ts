import { randomUUID } from 'node:crypto';
import { executionGraphsMigration } from './execution-graphs-migration';
import { executionGraphTriggersMigration } from './execution-graph-triggers-migration';
import { recordedDeploymentLocation } from '../../modules/deployments/deployment-scope';
import type { Database } from './schema';
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

async function createTables(
  db: Kysely<unknown>,
  definitions: readonly TableDefinition[],
  tableIndexes: typeof indexes,
): Promise<void> {
  for (const definition of definitions) {
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
  for (const [table, columns] of tableIndexes) {
    await db.schema
      .createIndex(`${table}_${columns.join('_')}_idx`)
      .on(table)
      .columns(columns)
      .execute();
  }
}

async function up(db: Kysely<unknown>): Promise<void> {
  await createTables(db, tables, indexes);
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
      .set({
        status: 'CANCELLED',
        updated_at: now,
        finished_at: now,
        error_summary: '拆分交付任务已随数据库降级取消',
      })
      .where('task_type', '=', 'PIPELINE')
      .where(splitTask)
      .where('status', '=', 'PENDING')
      .returning('id')
      .execute();
    for (const task of cancelled) {
      await db
        .updateTable('task_targets')
        .set({ status: 'CANCELLED', finished_at: now })
        .where('task_id', '=', task.id)
        .where('status', '=', 'PENDING')
        .execute();
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
    await db.schema
      .alterTable('service_environment_configs')
      .addColumn('release_policy_json', 'text', (column) => column.notNull().defaultTo('{}'))
      .execute();
    await db.schema
      .alterTable('deployment_records')
      .addColumn('release_snapshot_json', 'text')
      .execute();
    await db.schema
      .alterTable('deployment_records')
      .addColumn('rollback_of_deployment_id', 'text')
      .execute();
    await db.schema.alterTable('deployment_records').addColumn('activated_at', 'bigint').execute();
    await db.schema.alterTable('tasks').addColumn('release_approved_by', 'text').execute();
  },
  async down(db) {
    // A downgraded Worker must never run tasks that were waiting for approval.
    const waiting = db
      .selectFrom('tasks')
      .select('id')
      .where('status', '=', 'PENDING')
      .where('available_at', '=', Number.MAX_SAFE_INTEGER);
    await db
      .updateTable('task_targets')
      .set({ status: 'CANCELLED', finished_at: Date.now() })
      .where('status', '=', 'PENDING')
      .where('task_id', 'in', waiting)
      .execute();
    await db
      .updateTable('tasks')
      .set({
        status: 'CANCELLED',
        finished_at: Date.now(),
        error_summary: '发布审批已随数据库降级取消',
      })
      .where('status', '=', 'PENDING')
      .where('available_at', '=', Number.MAX_SAFE_INTEGER)
      .execute();
    await db.schema.alterTable('tasks').dropColumn('release_approved_by').execute();
    await db.schema.alterTable('deployment_records').dropColumn('activated_at').execute();
    await db.schema
      .alterTable('deployment_records')
      .dropColumn('rollback_of_deployment_id')
      .execute();
    await db.schema.alterTable('deployment_records').dropColumn('release_snapshot_json').execute();
    await db.schema
      .alterTable('service_environment_configs')
      .dropColumn('release_policy_json')
      .execute();
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

const operationScheduleTables: TableDefinition[] = [
  {
    name: 'operation_schedules',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['name', 'text'],
      ['owner_id', 'text', { references: 'users.id' }],
      ['kind', 'text'],
      ['source_id', 'text'],
      ['source_version', 'integer'],
      ['config_json', 'text'],
      ['approved_targets_json', 'text'],
      ['status', 'text'],
      ['status_reason', 'text', { nullable: true }],
      ['next_run_at', 'bigint', { nullable: true }],
      ['revision', 'integer', { default: 1 }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
  },
  {
    name: 'operation_schedule_runs',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['schedule_id', 'text', { references: 'operation_schedules.id' }],
      ['scheduled_at', 'bigint'],
      ['triggered_at', 'bigint'],
      ['status', 'text'],
      ['reason', 'text', { nullable: true }],
      ['task_id', 'text', { nullable: true, references: 'tasks.id' }],
      ['confirmation_expires_at', 'bigint', { nullable: true }],
      ['missed_until', 'bigint', { nullable: true }],
      ['snapshot_json', 'text'],
    ],
    unique: [['schedule_id', 'scheduled_at']],
  },
];

const operationSchedulesMigration: Migration = {
  async up(db) {
    await createTables(db, operationScheduleTables, [
      ['operation_schedules', ['status', 'next_run_at']],
      ['operation_schedule_runs', ['status', 'confirmation_expires_at']],
    ]);
  },
  async down(db) {
    for (const { name } of [...operationScheduleTables].reverse())
      await db.schema.dropTable(name).execute();
  },
};

const notificationTables: TableDefinition[] = [
  {
    name: 'notification_events',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['task_id', 'text', { references: 'tasks.id' }],
      ['project_id', 'text', { references: 'projects.id' }],
      ['service_id', 'text', { nullable: true, references: 'services.id' }],
      ['environment_id', 'text', { nullable: true, references: 'environments.id' }],
      ['stage', 'text'],
      ['level', 'text'],
      ['status', 'text'],
      ['summary_json', 'text'],
      ['created_at', 'bigint'],
    ],
    unique: [['task_id', 'stage']],
  },
  {
    name: 'user_notifications',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['event_id', 'text', { references: 'notification_events.id', onDelete: 'cascade' }],
      ['user_id', 'text', { references: 'users.id', onDelete: 'cascade' }],
      ['read_at', 'bigint', { nullable: true }],
      ['created_at', 'bigint'],
    ],
    unique: [['event_id', 'user_id']],
  },
  {
    name: 'notification_preferences',
    columns: [
      ['user_id', 'text', { primaryKey: true, references: 'users.id', onDelete: 'cascade' }],
      ['email', 'text', { nullable: true }],
      ['email_enabled', 'integer', { default: 0 }],
      ['minimum_level', 'text', { default: 'FAILURE' }],
      ['verified_at', 'bigint', { nullable: true }],
      ['verification_hash', 'text', { nullable: true }],
      ['verification_expires_at', 'bigint', { nullable: true }],
      ['verification_requested_at', 'bigint', { nullable: true }],
      ['verification_attempts', 'integer', { default: 0 }],
    ],
  },
  {
    name: 'notification_subscriptions',
    columns: [
      ['user_id', 'text', { references: 'users.id', onDelete: 'cascade' }],
      ['project_id', 'text', { references: 'projects.id', onDelete: 'cascade' }],
      ['stage', 'text'],
    ],
    primaryKey: ['user_id', 'project_id', 'stage'],
  },
  {
    name: 'notification_mail',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['notification_id', 'text', { references: 'user_notifications.id', onDelete: 'cascade' }],
      ['status', 'text'],
      ['attempts', 'integer', { default: 0 }],
      ['available_at', 'bigint'],
      ['lease_id', 'text', { nullable: true }],
      ['lease_expires_at', 'bigint', { nullable: true }],
      ['sent_at', 'bigint', { nullable: true }],
      ['error', 'text', { nullable: true }],
    ],
    unique: [['notification_id']],
  },
];

const notificationsMigration: Migration = {
  async up(db) {
    await createTables(db, notificationTables, [
      ['user_notifications', ['user_id', 'created_at']],
      ['user_notifications', ['user_id', 'read_at']],
      ['notification_subscriptions', ['project_id', 'stage']],
      ['notification_mail', ['status', 'available_at']],
    ]);
  },
  async down(db) {
    for (const { name } of [...notificationTables].reverse())
      await db.schema.dropTable(name).execute();
  },
};

const directDeploymentSelectionMigration: Migration = {
  async up(db) {
    await db.schema
      .alterTable('server_group_members')
      .addColumn('sort_order', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();
    const selections = ['service_environment_configs', 'pipeline_webhooks', 'pipeline_runs'];
    for (const table of selections) {
      await db.schema.alterTable(table).addColumn('target_selection_json', 'text').execute();
    }
    // Replace only the legacy column rather than rebuilding tables referenced by artifacts and history.
    for (const table of ['pipeline_webhooks', 'pipeline_runs']) {
      await db.schema
        .alterTable(table)
        .addColumn('legacy_target_id', 'text', (column) =>
          column.references('deployment_targets.id').onDelete('restrict'),
        )
        .execute();
      await db
        .updateTable(table)
        .set((eb) => ({ legacy_target_id: eb.ref('target_id') }))
        .execute();
      await db.schema.alterTable(table).dropColumn('target_id').execute();
      await db.schema.alterTable(table).renameColumn('legacy_target_id', 'target_id').execute();
    }
    const legacy = await db.selectFrom('deployment_targets').selectAll().execute();
    for (const target of legacy) {
      const members = await db
        .selectFrom('deployment_target_servers as m')
        .innerJoin('servers as s', 's.id', 'm.server_id')
        .select(['m.server_id', 's.is_active'])
        .where('m.target_id', '=', target.id)
        .orderBy('m.sort_order')
        .execute();
      const value = JSON.stringify({
        serverIds: members.map((member) => member.server_id),
        groupIds: [],
        strategy: target.strategy,
        maxParallel: target.max_parallel,
        failurePolicy: target.failure_policy,
      });
      await db
        .updateTable('service_environment_configs')
        .set({ target_selection_json: value })
        .where('target_id', '=', target.id)
        .execute();
      await db
        .updateTable('pipeline_webhooks')
        .set({
          target_selection_json: value,
          ...((!members.length || members.some((member) => member.is_active !== 1)) && {
            enabled: 0,
          }),
        })
        .where('target_id', '=', target.id)
        .execute();
    }
  },
  async down(db) {
    for (const table of ['pipeline_webhooks', 'pipeline_runs', 'service_environment_configs']) {
      const direct = await db
        .selectFrom(table)
        .select('target_selection_json')
        .where('target_id', 'is', null)
        .where('target_selection_json', 'is not', null)
        .executeTakeFirst();
      if (direct) throw new Error('直接选择的发布记录或配置无法转换回旧目标，请恢复升级前备份');
    }
    for (const table of ['pipeline_webhooks', 'pipeline_runs', 'service_environment_configs']) {
      await db.schema.alterTable(table).dropColumn('target_selection_json').execute();
    }
    await db.schema.alterTable('server_group_members').dropColumn('sort_order').execute();
  },
};

const repositoryBranchCacheMigration: Migration = {
  async up(db) {
    await db.schema.alterTable('repositories').addColumn('branch_cache_json', 'text').execute();
    await db.schema.alterTable('repositories').addColumn('branch_checked_at', 'bigint').execute();
    await db.schema.alterTable('repositories').addColumn('branch_error', 'text').execute();
    await db.schema.alterTable('repositories').addColumn('branch_request_id', 'text').execute();
  },
  async down(db) {
    for (const column of [
      'branch_request_id',
      'branch_error',
      'branch_checked_at',
      'branch_cache_json',
    ])
      await db.schema.alterTable('repositories').dropColumn(column).execute();
  },
};

const pipelineTriggerTables: TableDefinition[] = [
  {
    name: 'pipeline_triggers',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['pipeline_id', 'text', { references: 'pipelines.id' }],
      ['kind', 'text'],
      ['version', 'integer'],
      ['environment_id', 'text'],
      ['branch', 'text'],
      ['repository_id', 'text'],
      ['owner_id', 'text'],
      ['configuration_hash', 'text'],
      ['repository_hash', 'text'],
      ['timing_json', 'text'],
      ['target_json', 'text', { nullable: true }],
      ['mode', 'text'],
      ['build_current', 'integer'],
      ['baseline_sha', 'text', { nullable: true }],
      ['status', 'text'],
      ['reason', 'text', { nullable: true }],
      ['next_at', 'bigint', { nullable: true }],
      ['anchor_at', 'bigint'],
      ['lease_id', 'text', { nullable: true }],
      ['lease_until', 'bigint', { nullable: true }],
      ['failures', 'integer'],
    ],
  },
  {
    name: 'pipeline_trigger_history',
    columns: [
      ['id', 'text', { primaryKey: true }],
      ['pipeline_id', 'text', { references: 'pipelines.id' }],
      ['kind', 'text'],
      ['status', 'text'],
      ['version', 'integer', { nullable: true }],
      ['environment_id', 'text', { nullable: true }],
      ['branch', 'text', { nullable: true }],
      ['commit_sha', 'text', { nullable: true }],
      ['mode', 'text', { nullable: true }],
      ['task_id', 'text', { nullable: true }],
      ['reason', 'text', { nullable: true }],
      ['scheduled_at', 'bigint', { nullable: true }],
      ['trigger_id', 'text', { nullable: true }],
      ['created_at', 'bigint'],
    ],
    unique: [['trigger_id', 'scheduled_at']],
  },
];

const pipelineTriggersMigration: Migration = {
  async up(db) {
    await createTables(db, pipelineTriggerTables, [
      ['pipeline_triggers', ['status', 'next_at']],
      ['pipeline_trigger_history', ['pipeline_id', 'created_at']],
    ]);
  },
  async down(db) {
    for (const { name } of [...pipelineTriggerTables].reverse())
      await db.schema.dropTable(name).execute();
  },
};

const aiFailureTables: TableDefinition[] = [
  {
    name: 'ai_failure_settings',
    columns: [
      ['service_id', 'text', { references: 'services.id', onDelete: 'cascade' }],
      ['environment_id', 'text', { references: 'environments.id', onDelete: 'cascade' }],
      ['enabled', 'integer'],
      ['component', 'text', { nullable: true }],
      ['revision', 'text'],
    ],
    primaryKey: ['service_id', 'environment_id'],
  },
  {
    name: 'ai_failure_incidents',
    columns: [
      ['task_id', 'text', { primaryKey: true, references: 'tasks.id', onDelete: 'cascade' }],
      ['service_id', 'text'],
      ['environment_id', 'text'],
      ['revision', 'text'],
      ['status', 'text'],
      ['summary', 'text'],
      ['findings_json', 'text', { default: '[]' }],
      ['proposal_id', 'text', { nullable: true }],
      ['repair_task_id', 'text', { nullable: true }],
      ['created_at', 'bigint'],
      ['updated_at', 'bigint'],
    ],
    unique: [['proposal_id'], ['repair_task_id']],
  },
];

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
      '010_operation_schedules': operationSchedulesMigration,
      '011_notifications': notificationsMigration,
      '012_direct_deployment_selection': directDeploymentSelectionMigration,
      '013_repository_branch_cache': repositoryBranchCacheMigration,
      '014_pipeline_triggers': pipelineTriggersMigration,
      '015_automatic_execution_mode': {
        async up(db) {
          await db.schema
            .alterTable('service_environment_configs')
            .addColumn('execution_mode', 'text')
            .execute();
          await db.schema
            .alterTable('pipeline_webhooks')
            .addColumn('follow_mode', 'integer', (c) => c.notNull().defaultTo(0))
            .execute();
          await db.schema
            .alterTable('pipeline_webhooks')
            .addColumn('confirmed_mode', 'text', (c) => c.notNull().defaultTo('BUILD_ONLY'))
            .execute();
          await sql`insert into pipeline_trigger_history
            (id, pipeline_id, kind, status, version, environment_id, branch, commit_sha, mode, task_id, created_at)
            select 'legacy:' || r.id, r.pipeline_id, 'WEBHOOK', 'QUEUED', v.version, r.environment_id,
              substr(r.git_ref, 12), r.commit_sha, 'BUILD_ONLY', r.task_id, r.created_at
            from pipeline_runs r join pipeline_versions v on v.id = r.pipeline_version_id
            where r.trigger_type = 'WEBHOOK'`.execute(db);
        },
        async down(db) {
          await db.deleteFrom('pipeline_trigger_history').where('id', 'like', 'legacy:%').execute();
          await db.schema.alterTable('pipeline_webhooks').dropColumn('confirmed_mode').execute();
          await db.schema.alterTable('pipeline_webhooks').dropColumn('follow_mode').execute();
          await db.schema
            .alterTable('service_environment_configs')
            .dropColumn('execution_mode')
            .execute();
        },
      } satisfies Migration,
      '016_ai_failure_handling': {
        async up(db) {
          await createTables(db, aiFailureTables, [
            ['ai_failure_incidents', ['status', 'updated_at']],
            ['ai_failure_incidents', ['service_id', 'environment_id', 'created_at']],
          ]);
        },
        async down(db) {
          for (const { name } of [...aiFailureTables].reverse())
            await db.schema.dropTable(name).execute();
        },
      } satisfies Migration,
      '017_linux_monitoring': {
        async up(db) {
          await createTables(
            db,
            [
              {
                name: 'monitor_settings',
                columns: [
                  ['id', 'integer', { primaryKey: true }],
                  ['enabled', 'integer'],
                  ['interval_seconds', 'integer'],
                  ['retention_days', 'integer'],
                  ['concurrency', 'integer'],
                ],
              },
              {
                name: 'monitor_hosts',
                columns: [
                  [
                    'server_id',
                    'text',
                    { primaryKey: true, references: 'servers.id', onDelete: 'cascade' },
                  ],
                  ['enabled', 'integer'],
                  ['interface_name', 'text', { nullable: true }],
                  ['next_at', 'bigint'],
                  ['lease', 'text', { nullable: true }],
                  ['lease_until', 'bigint'],
                  ['failures', 'integer'],
                  ['attempt_at', 'bigint', { nullable: true }],
                  ['sampled_at', 'bigint', { nullable: true }],
                  ['raw_json', 'text', { nullable: true }],
                  ['metrics_json', 'text', { nullable: true }],
                  ['error', 'text', { nullable: true }],
                ],
              },
              {
                name: 'monitor_samples',
                columns: [
                  ['id', 'text', { primaryKey: true }],
                  ['server_id', 'text', { references: 'servers.id', onDelete: 'cascade' }],
                  ['at', 'bigint'],
                  ['raw_json', 'text', { nullable: true }],
                  ['metrics_json', 'text', { nullable: true }],
                ],
              },
            ],
            [
              ['monitor_samples', ['server_id', 'at']],
              ['monitor_samples', ['at']],
              ['monitor_hosts', ['next_at']],
            ],
          );
          await sql`insert into monitor_settings (id,enabled,interval_seconds,retention_days,concurrency) values (1,0,60,7,3)`.execute(
            db,
          );
        },
        async down(db) {
          for (const name of ['monitor_samples', 'monitor_hosts', 'monitor_settings'])
            await db.schema.dropTable(name).execute();
        },
      } satisfies Migration,
      '018_project_execution_graphs': executionGraphsMigration,
      '019_execution_graph_triggers': executionGraphTriggersMigration,
      '020_project_variables': {
        async up(db) {
          await createTables(
            db,
            [
              {
                name: 'project_variables',
                columns: [
                  ['id', 'text', { primaryKey: true }],
                  ['project_id', 'text', { references: 'projects.id', onDelete: 'cascade' }],
                  ['key', 'text'],
                  ['value_text', 'text', { nullable: true }],
                  [
                    'credential_id',
                    'text',
                    { nullable: true, references: 'credentials.id', onDelete: 'restrict' },
                  ],
                  ['is_secret', 'integer', { default: 0 }],
                  ['description', 'text', { default: '' }],
                  ['created_at', 'bigint', { default: 0 }],
                  ['updated_at', 'bigint', { default: 0 }],
                ],
                unique: [['project_id', 'key']],
                checks: [
                  '(is_secret = 0 AND value_text IS NOT NULL AND credential_id IS NULL) OR (is_secret = 1 AND value_text IS NULL AND credential_id IS NOT NULL)',
                ],
              },
            ],
            [],
          );
          const now = Date.now();
          for (const table of ['environment_variables', 'service_environment_variables']) {
            await db.schema
              .alterTable(table)
              .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
              .execute();
            // SQLite only supports one ADD COLUMN per ALTER TABLE statement.
            for (const column of ['created_at', 'updated_at']) {
              await db.schema
                .alterTable(table)
                .addColumn(column, 'bigint', (c) => c.notNull().defaultTo(now))
                .execute();
            }
          }
        },
        async down(db) {
          for (const table of ['environment_variables', 'service_environment_variables']) {
            for (const column of ['description', 'created_at', 'updated_at'])
              await db.schema.alterTable(table).dropColumn(column).execute();
          }
          await db.schema.dropTable('project_variables').execute();
        },
      } satisfies Migration,
      '021_graph_artifact_provenance': {
        async up(db) {
          await db.schema
            .alterTable('environments')
            .addColumn('repository_env_file', 'text')
            .execute();
          for (const column of [
            'artifact_name',
            'artifact_kind',
            'graph_run_id',
            'graph_node_run_id',
          ])
            await db.schema.alterTable('artifacts').addColumn(column, 'text').execute();
          await db.schema
            .createIndex('artifacts_graph_node_idx')
            .on('artifacts')
            .columns(['graph_run_id', 'graph_node_run_id'])
            .execute();
        },
        async down(db) {
          await db.schema.alterTable('environments').dropColumn('repository_env_file').execute();
          await db.schema.dropIndex('artifacts_graph_node_idx').execute();
          for (const column of [
            'artifact_name',
            'artifact_kind',
            'graph_run_id',
            'graph_node_run_id',
          ])
            await db.schema.alterTable('artifacts').dropColumn(column).execute();
        },
      } satisfies Migration,
      '022_service_source_reviews': {
        async up(db) {
          await createTables(
            db,
            [
              {
                name: 'service_source_reviews',
                columns: [
                  ['id', 'text', { primaryKey: true }],
                  ['project_id', 'text', { references: 'projects.id', onDelete: 'cascade' }],
                  ['service_id', 'text', { references: 'services.id', onDelete: 'cascade' }],
                  [
                    'environment_id',
                    'text',
                    { references: 'environments.id', onDelete: 'cascade' },
                  ],
                  ['commit_sha', 'text'],
                  ['decision', 'text'],
                  ['reason', 'text', { nullable: true }],
                  ['reviewed_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
                  ['created_at', 'bigint'],
                  ['updated_at', 'bigint'],
                ],
                unique: [['project_id', 'service_id', 'environment_id', 'commit_sha']],
                checks: ["decision in ('APPROVED', 'REVOKED')", 'length(commit_sha) in (40, 64)'],
              },
            ],
            [],
          );
          await db.schema
            .createIndex('service_source_reviews_scope_idx')
            .on('service_source_reviews')
            .columns(['service_id', 'environment_id', 'updated_at'])
            .execute();
        },
        async down(db) {
          await db.schema.dropTable('service_source_reviews').execute();
        },
      } satisfies Migration,
      '023_project_resource_lifecycle': {
        async up(db) {
          for (const table of ['repositories', 'services', 'environments'])
            await db.schema.alterTable(table).addColumn('archived_at', 'bigint').execute();
          await db.schema
            .alterTable('execution_graph_versions')
            .addColumn('retired_at', 'bigint')
            .execute();
        },
        async down(db) {
          await db.schema.alterTable('execution_graph_versions').dropColumn('retired_at').execute();
          for (const table of ['environments', 'services', 'repositories'])
            await db.schema.alterTable(table).dropColumn('archived_at').execute();
        },
      } satisfies Migration,
      '024_environment_execution_settings': {
        async up(db) {
          await db.schema
            .alterTable('environments')
            .addColumn('default_target_selection_json', 'text')
            .execute();
          await createServiceVariablesTable(db, true);
          await sql`insert into service_environment_variables_next
            (id, service_id, environment_id, key, value_text, credential_id, is_secret, description, created_at, updated_at)
            select v.id, c.service_id, c.environment_id, v.key, v.value_text, v.credential_id,
              v.is_secret, v.description, v.created_at, v.updated_at
            from service_environment_variables v join service_environment_configs c on c.id = v.config_id`.execute(
            db,
          );
          await db.schema.dropTable('service_environment_variables').execute();
          await db.schema
            .alterTable('service_environment_variables_next')
            .renameTo('service_environment_variables')
            .execute();
        },
        async down(db) {
          await createServiceVariablesTable(db, false);
          const missing = await sql<{ service_id: string; environment_id: string }>`
            select distinct v.service_id, v.environment_id
            from service_environment_variables v left join service_environment_configs c
              on c.service_id = v.service_id and c.environment_id = v.environment_id
            where c.id is null`.execute(db);
          const now = Date.now();
          for (const { service_id, environment_id } of missing.rows) {
            await sql`insert into service_environment_configs
              (id, service_id, environment_id, created_at, updated_at)
              values (${randomUUID()}, ${service_id}, ${environment_id}, ${now}, ${now})`.execute(
              db,
            );
          }
          await sql`insert into service_environment_variables_previous
            (id, config_id, key, value_text, credential_id, is_secret, description, created_at, updated_at)
            select v.id, c.id, v.key, v.value_text, v.credential_id, v.is_secret,
              v.description, v.created_at, v.updated_at
            from service_environment_variables v join service_environment_configs c
              on c.service_id = v.service_id and c.environment_id = v.environment_id`.execute(db);
          await db.schema.dropTable('service_environment_variables').execute();
          await db.schema
            .alterTable('service_environment_variables_previous')
            .renameTo('service_environment_variables')
            .execute();
          await db.schema
            .alterTable('environments')
            .dropColumn('default_target_selection_json')
            .execute();
        },
      } satisfies Migration,
      '025_artifact_source_manifest': {
        async up(db) {
          await db.schema.alterTable('artifacts').addColumn('source_manifest', 'integer').execute();
          await db.schema
            .createTable('artifact_sources')
            .addColumn('artifact_id', 'text', (column) =>
              column.notNull().references('artifacts.id').onDelete('cascade'),
            )
            .addColumn('position', 'integer', (column) => column.notNull())
            .addColumn('repository_id', 'text', (column) => column.notNull())
            .addColumn('commit_sha', 'text', (column) => column.notNull())
            .addColumn('git_ref', 'text')
            .addColumn('commit_subject', 'text')
            .addColumn('workspace_run_id', 'text')
            .addColumn('workspace_node_run_id', 'text')
            .addColumn('path', 'text')
            .addPrimaryKeyConstraint('artifact_sources_pk', ['artifact_id', 'position'])
            .execute();
          await db.schema
            .createIndex('artifact_sources_repository_commit')
            .on('artifact_sources')
            .columns(['repository_id', 'commit_sha'])
            .execute();
        },
        async down(db) {
          await db.schema.dropTable('artifact_sources').execute();
          await db.schema.alterTable('artifacts').dropColumn('source_manifest').execute();
        },
      } satisfies Migration,
      '026_repository_source_reviews': {
        async up(db) {
          await createTables(
            db,
            [
              {
                name: 'repository_source_reviews',
                columns: [
                  ['id', 'text', { primaryKey: true }],
                  ['project_id', 'text', { references: 'projects.id', onDelete: 'cascade' }],
                  ['service_id', 'text', { references: 'services.id', onDelete: 'cascade' }],
                  [
                    'environment_id',
                    'text',
                    { references: 'environments.id', onDelete: 'cascade' },
                  ],
                  [
                    'repository_id',
                    'text',
                    { references: 'repositories.id', onDelete: 'restrict' },
                  ],
                  ['commit_sha', 'text'],
                  ['decision', 'text'],
                  ['reason', 'text', { nullable: true }],
                  ['reviewed_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
                  ['created_at', 'bigint'],
                  ['updated_at', 'bigint'],
                ],
                unique: [
                  ['project_id', 'service_id', 'environment_id', 'repository_id', 'commit_sha'],
                ],
                checks: ["decision in ('APPROVED', 'REVOKED')", 'length(commit_sha) in (40, 64)'],
              },
            ],
            [],
          );
        },
        async down(db) {
          await db.schema.dropTable('repository_source_reviews').execute();
        },
      } satisfies Migration,
      '027_service_compose_templates': {
        async up(db) {
          await createTables(
            db,
            [
              {
                name: 'service_compose_templates',
                columns: [
                  ['id', 'text', { primaryKey: true }],
                  ['service_id', 'text', { references: 'services.id', onDelete: 'cascade' }],
                  [
                    'environment_id',
                    'text',
                    { references: 'environments.id', onDelete: 'cascade' },
                  ],
                  ['version', 'integer'],
                  ['content', 'text', { nullable: true }],
                  ['checksum', 'text', { nullable: true }],
                  ['created_by', 'text', { references: 'users.id', onDelete: 'restrict' }],
                  ['created_at', 'bigint'],
                ],
                unique: [['service_id', 'environment_id', 'version']],
                checks: [
                  'version > 0',
                  '(content is null and checksum is null) or (content is not null and length(checksum) = 64 and checksum is not null)',
                ],
              },
            ],
            [],
          );
          await db.schema
            .alterTable('deployment_records')
            .addColumn('compose_release_json', 'text')
            .execute();
        },
        async down(db) {
          await db.schema
            .alterTable('deployment_records')
            .dropColumn('compose_release_json')
            .execute();
          await db.schema.dropTable('service_compose_templates').execute();
        },
      } satisfies Migration,
      '028_service_addresses': {
        async up(db) {
          await db.schema
            .alterTable('services')
            .addColumn('revision', 'integer', (column) => column.notNull().defaultTo(1))
            .execute();
          await createTables(
            db,
            [
              {
                name: 'service_addresses',
                columns: [
                  ['id', 'text', { primaryKey: true }],
                  ['service_id', 'text', { references: 'services.id', onDelete: 'cascade' }],
                  ['name', 'text'],
                  ['url', 'text'],
                  ['position', 'integer'],
                ],
                unique: [['service_id', 'position']],
                checks: ['position >= 0'],
              },
            ],
            [],
          );
        },
        async down(db) {
          await db.schema.dropTable('service_addresses').execute();
          await db.schema.alterTable('services').dropColumn('revision').execute();
        },
      } satisfies Migration,
      '029_project_environment_sets': {
        async up(db) {
          await createTables(
            db,
            [
              {
                name: 'project_environment_sets',
                columns: [
                  ['id', 'text', { primaryKey: true }],
                  ['project_id', 'text', { references: 'projects.id', onDelete: 'cascade' }],
                  ['name', 'text'],
                  ['description', 'text', { default: '' }],
                  ['revision', 'integer', { default: 1 }],
                  ['archived_at', 'bigint', { nullable: true }],
                  ['created_at', 'bigint'],
                  ['updated_at', 'bigint'],
                ],
                checks: ['revision >= 1', 'length(name) between 1 and 100'],
              },
              {
                name: 'project_environment_set_variables',
                columns: [
                  ['id', 'text', { primaryKey: true }],
                  [
                    'environment_set_id',
                    'text',
                    { references: 'project_environment_sets.id', onDelete: 'cascade' },
                  ],
                  ['key', 'text'],
                  ['value_text', 'text', { nullable: true }],
                  [
                    'credential_id',
                    'text',
                    { references: 'credentials.id', onDelete: 'restrict', nullable: true },
                  ],
                  ['is_secret', 'integer', { default: 0 }],
                  ['description', 'text', { default: '' }],
                  ['created_at', 'bigint'],
                  ['updated_at', 'bigint'],
                ],
                unique: [['environment_set_id', 'key']],
                checks: [
                  'length(key) between 1 and 128',
                  '(is_secret = 0 and value_text is not null and credential_id is null) or (is_secret = 1 and value_text is null and credential_id is not null)',
                ],
              },
            ],
            [['project_environment_sets', ['project_id', 'archived_at', 'name']]],
          );
        },
        async down(db) {
          await db.schema.dropTable('project_environment_set_variables').execute();
          await db.schema.dropTable('project_environment_sets').execute();
        },
      } satisfies Migration,
      '030_graph_node_evidence': {
        async up(db) {
          await db.schema
            .alterTable('execution_node_runs')
            .addColumn('evidence_json', 'text')
            .execute();
        },
        async down(db) {
          await db.schema.alterTable('execution_node_runs').dropColumn('evidence_json').execute();
        },
      } satisfies Migration,
      '031_artifact_physical_instances': {
        async up(db) {
          for (const column of [
            'logical_artifact_id',
            'physical_json',
            'physical_key',
            'temporary_root_id',
            'environment_set_id',
            'verification_status',
            'verification_reason',
            'verified_by',
          ])
            await db.schema.alterTable('artifacts').addColumn(column, 'text').execute();
          await db.schema.alterTable('artifacts').addColumn('verified_at', 'bigint').execute();
          await db.schema
            .alterTable('artifacts')
            .addColumn('lifecycle_state', 'text', (column) => column.notNull().defaultTo('ACTIVE'))
            .execute();
          await db.schema
            .createIndex('artifacts_logical_instance')
            .on('artifacts')
            .columns(['project_id', 'logical_artifact_id', 'lifecycle_state'])
            .execute();
          await db.schema
            .createIndex('artifacts_physical_location')
            .on('artifacts')
            .columns(['physical_key', 'lifecycle_state'])
            .execute();
          await db.schema
            .createIndex('artifacts_temporary_root')
            .on('artifacts')
            .columns(['temporary_root_id', 'lifecycle_state'])
            .execute();
        },
        async down(db) {
          for (const index of [
            'artifacts_temporary_root',
            'artifacts_physical_location',
            'artifacts_logical_instance',
          ])
            await db.schema.dropIndex(index).execute();
          for (const column of [
            'verified_by',
            'verified_at',
            'verification_reason',
            'verification_status',
            'lifecycle_state',
            'environment_set_id',
            'temporary_root_id',
            'physical_key',
            'physical_json',
            'logical_artifact_id',
          ])
            await db.schema.alterTable('artifacts').dropColumn(column).execute();
        },
      } satisfies Migration,
      '032_artifact_cleanup_jobs': {
        async up(db) {
          await createTables(
            db,
            [
              {
                name: 'artifact_cleanup_jobs',
                columns: [
                  ['id', 'text', { primaryKey: true }],
                  ['request_key', 'text'],
                  ['request_hash', 'text'],
                  ['requested_by', 'text', { nullable: true }],
                  ['authorized_by', 'text', { nullable: true }],
                  ['created_at', 'bigint'],
                ],
                unique: [['request_key']],
              },
              {
                name: 'artifact_cleanup_items',
                columns: [
                  [
                    'job_id',
                    'text',
                    { references: 'artifact_cleanup_jobs.id', onDelete: 'cascade' },
                  ],
                  ['instance_id', 'text', { references: 'artifacts.id', onDelete: 'restrict' }],
                  ['artifact_id', 'text'],
                  ['group_key', 'text'],
                  ['action', 'text'],
                  ['status', 'text'],
                  ['attempts', 'integer', { default: 0 }],
                  ['cycle_attempts', 'integer', { default: 0 }],
                  ['reason', 'text', { nullable: true }],
                  ['available_at', 'bigint', { nullable: true }],
                  ['lease_id', 'text', { nullable: true }],
                  ['lease_until', 'bigint', { nullable: true }],
                  ['updated_at', 'bigint'],
                ],
                primaryKey: ['job_id', 'instance_id'],
                checks: [
                  "action in ('REMOVE', 'DETACH')",
                  "status in ('PENDING', 'RUNNING', 'RETRY', 'DELETED', 'RETAINED')",
                ],
              },
            ],
            [
              ['artifact_cleanup_items', ['status', 'available_at', 'lease_until']],
              ['artifact_cleanup_items', ['job_id', 'group_key']],
            ],
          );
        },
        async down(db) {
          await db.schema.dropTable('artifact_cleanup_items').execute();
          await db.schema.dropTable('artifact_cleanup_jobs').execute();
        },
      } satisfies Migration,
      '033_deployment_release_scope': {
        async up(database) {
          await database.schema
            .alterTable('deployment_records')
            .addColumn('release_scope_key', 'text')
            .execute();
          await database.schema
            .alterTable('deployment_records')
            .addColumn('release_path_key', 'text')
            .execute();
          const db = database as Kysely<Database>;
          let after: string | undefined;
          for (;;) {
            const rows = await db
              .selectFrom('deployment_records as deployment')
              .innerJoin('pipeline_runs as run', 'run.id', 'deployment.pipeline_run_id')
              .select([
                'deployment.id',
                'run.project_id',
                'deployment.service_id',
                'deployment.environment_id',
                'deployment.server_id',
                'deployment.deploy_path',
                'run.artifact_type_snapshot',
                'deployment.release_snapshot_json',
              ])
              .$if(after !== undefined, (query) => query.where('deployment.id', '>', after!))
              .orderBy('deployment.id')
              .limit(250)
              .execute();
            if (!rows.length) break;
            for (const row of rows) {
              const location = recordedDeploymentLocation(row);
              if (location)
                await db
                  .updateTable('deployment_records')
                  .set({ release_scope_key: location.scope, release_path_key: location.path })
                  .where('id', '=', row.id)
                  .execute();
            }
            after = rows[rows.length - 1]!.id;
          }
          await db.schema
            .createIndex('deployment_records_release_scope')
            .on('deployment_records')
            .column('release_scope_key')
            .execute();
          await db.schema
            .createIndex('deployment_records_server_release_path')
            .on('deployment_records')
            .columns(['server_id', 'release_path_key'])
            .execute();
        },
        async down(db) {
          await db.schema.dropIndex('deployment_records_server_release_path').execute();
          await db.schema.dropIndex('deployment_records_release_scope').execute();
          await db.schema.alterTable('deployment_records').dropColumn('release_path_key').execute();
          await db.schema
            .alterTable('deployment_records')
            .dropColumn('release_scope_key')
            .execute();
        },
      } satisfies Migration,
    };
  },
};

async function createServiceVariablesTable(db: Kysely<unknown>, independent: boolean) {
  const legacy = tables.find((table) => table.name === 'service_environment_variables')!;
  const now = Date.now();
  await createTables(
    db,
    [
      {
        name: independent
          ? 'service_environment_variables_next'
          : 'service_environment_variables_previous',
        columns: [
          ...legacy.columns.filter(([name]) => !independent || name !== 'config_id'),
          ...(independent
            ? ([
                ['service_id', 'text', { references: 'services.id' }],
                ['environment_id', 'text', { references: 'environments.id' }],
              ] as const)
            : []),
          ['description', 'text', { default: '' }],
          ['created_at', 'bigint', { default: now }],
          ['updated_at', 'bigint', { default: now }],
        ],
        unique: independent ? [['service_id', 'environment_id', 'key']] : legacy.unique,
        checks: legacy.checks,
      },
    ],
    [],
  );
}
