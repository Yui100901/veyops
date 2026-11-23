import type { ProjectDetail } from '../models';
import { graphNodeLabels } from './execution-graph-definition';
import type {
  GraphEdge,
  GraphEnvironmentSetSummary,
  GraphFieldEvidence,
  GraphFieldSource,
  GraphNode,
} from './execution-graph-definition';
import { deliveryPath } from './delivery-route';
import {
  artifactVerificationLabels,
  type ArtifactPhysical,
  type ArtifactVerification,
} from './Delivery';
import { projectResourcePath } from './project-workspace-route';
import { graphWorkbenchPath } from './graph-workbench-context';
import { serverResourceHref } from './server-resource-route';
import './execution-graph-preview.css';

interface NodeScope {
  flowId?: string;
  nodeId?: string;
  flowName?: string;
  nodeName?: string;
}

interface PlanTarget extends NodeScope {
  purpose: 'BUILD' | 'RELEASE';
  source: string;
  servers: { id: string; name: string; host?: string; port?: number }[];
  groupIds?: string[];
  strategy?: string;
  maxParallel?: number;
  failurePolicy?: string;
}

interface PlanSetting extends NodeScope {
  field: string;
  value: string | number | boolean | string[] | null;
  source: string;
}

interface PlanEnvironmentFile extends NodeScope {
  repositoryId?: string;
  commitSha?: string;
  branch?: string;
  tag?: string;
  path?: string;
  source: string;
  required?: boolean;
  status?: string;
  mappingKey?: string;
}

interface PlanVariable extends NodeScope {
  key: string;
  source: string;
  sensitive: boolean;
  overriddenSources?: string[];
  value?: string;
}

interface DeferredBinding extends NodeScope {
  field: string;
  producerNodeId?: string;
  producerField?: string;
}

interface ArtifactPreview {
  id: string;
  artifactId?: string;
  instanceId?: string;
  serverId?: string | null;
  physical?: ArtifactPhysical | null;
  verificationStatus?: ArtifactVerification;
  verificationReason?: string | null;
  temporary?: boolean;
  name?: string;
  type?: string;
  kind?: string;
  digest?: string;
  imageRepository?: string;
  imageReference?: string;
  composeTemplate?: { source: 'ARCHIVE'; path?: string; checksum: string };
  checksum?: string;
  commitSha?: string;
}

interface PreviewSource {
  id?: string;
  repositoryId?: string;
  branch?: string;
  tag?: string;
  ref?: string;
  path?: string;
  commitSha: string;
}

interface SourceReviewProof {
  repositoryId: string;
  commitSha: string;
  reviewId: string;
}

interface ArtifactChoice extends NodeScope {
  fieldId?: string;
  commitSha?: string;
  artifactIds?: string[];
  artifactRefs?: ArtifactPreview[];
  sourceSnapshot?: PreviewSource[];
  sourceReviews?: SourceReviewProof[] | null;
  sourceReviewPendingMaterialization?: boolean;
}

interface DeliveryPreview extends NodeScope {
  artifactFromNodeId?: string;
  artifactFromNodeName?: string;
  artifactFromField?: string;
  environmentId?: string;
  commitSha?: string;
  serverIds?: string[];
  artifactIds?: string[];
  artifactRefs?: ArtifactPreview[];
  requireApproval?: boolean;
  requireCodeReview?: boolean;
  sourceReviews?: SourceReviewProof[] | null;
  sourceReviewPendingMaterialization?: boolean;
  possibleArtifacts?: ArtifactChoice[];
  serviceId?: string;
  sourceSnapshot?: PreviewSource[];
  method?: 'FILE' | 'COMPOSE';
  composeSource?: { kind: 'ARTIFACT' | 'REPOSITORY_FILE' };
  composeTemplate?:
    | { source: 'ARCHIVE'; checksum: string }
    | {
        source: 'REPOSITORY_FILE';
        repositoryId: string;
        commitSha: string;
        path: string;
        checksum: string;
      };
  rollbackBaseline?: Record<string, string>;
}

type ReleaseGateKind = 'SOURCE_REVIEW' | 'APPROVAL' | 'HEALTH_CHECK' | 'ROLLBACK_ARTIFACT';

export interface Preview extends DeliveryPreview {
  configurationHash: string;
  planSections?: Record<string, string>;
  version: number;
  flowId: string;
  environmentSet?: GraphEnvironmentSetSummary | null;
  parameters?: Record<string, unknown>;
  parameterSources?: Record<string, GraphFieldSource>;
  routing?: (GraphEdge & { status: 'CERTAIN' | 'POSSIBLE' | 'EXCLUDED' | 'OUTSIDE_FLOW' })[];
  nodes: {
    nodeId: string;
    name: string;
    type: GraphNode['type'];
    selected?: boolean;
    conditional?: boolean;
    inputs?: GraphFieldEvidence[];
    outputFields?: GraphFieldEvidence[];
    environment?: GraphFieldEvidence[];
  }[];
  deliveries?: DeliveryPreview[];
  gates?: {
    flowId: string;
    nodeId: string;
    name: string;
    kind: ReleaseGateKind;
    releaseNodeId?: string;
    buildNodeId?: string;
  }[];
  checkouts?: (NodeScope & {
    repositoryId: string;
    repositoryName?: string;
    ref?: string;
    versionSource?: string;
    triggerRepositoryId?: string;
    triggerCommitSha?: string;
    branch?: string;
    tag?: string;
    commitSha: string;
    fullClone?: boolean;
    fetchMode?: 'LATEST' | 'FULL';
    fetchModeDeferred?: boolean;
  })[];
  scripts?: (NodeScope & {
    serverId?: string;
    serverName?: string;
    environmentId?: string;
    serviceId?: string;
  })[];
  executionPlan?: {
    targets: PlanTarget[];
    settings: PlanSetting[];
    environmentFiles: PlanEnvironmentFile[];
    variables: PlanVariable[];
    deferred: DeferredBinding[];
  };
}

function checkoutModeLabel(checkout: NonNullable<Preview['checkouts']>[number]) {
  if (checkout.fetchModeDeferred) return '拉取方式由上游运行结果确定';
  return checkout.fetchMode === 'FULL' || checkout.fullClone ? '完整拉取' : '拉取最新';
}

const sourceNames: Record<string, string> = {
  RUN_INPUT: '运行参数',
  INPUT: '运行参数',
  TRIGGER_VALUE: '触发规则固定值',
  TRIGGER_EVENT: '触发事件',
  TRIGGER_COMMIT: '触发事件固定提交',
  TRIGGER_REF: '触发事件 Git 引用',
  UPSTREAM_OUTPUT: '上游最终输出',
  DEFAULT: '字段默认值',
  VALUE: '节点固定值',
  NODE_INPUT: '本节点输入',
  ENVIRONMENT_KEY: '入口变量集合',
  CREDENTIAL: '凭据引用',
  AS_GIT_REF: '转换为 Git 版本',
  REPOSITORY_DEFAULT: '仓库默认分支',
  NODE: '节点配置',
  SYSTEM: '系统默认',
  SYSTEM_DEFAULT: '系统默认',
  PROJECT: '项目配置',
  PROJECT_DEFAULT: '项目默认',
  SERVICE_ENVIRONMENT: '服务环境覆盖',
  PROJECT_ENVIRONMENT: '项目环境默认',
  ENVIRONMENT: '项目环境',
  ENVIRONMENT_SET: '入口变量集合',
  ENVIRONMENT_CONFIG: '项目环境',
  LEGACY_TARGET: '旧部署目标',
  MANAGER: '管理端',
  CONVENTION: '约定路径',
  REPOSITORY_FILE: '仓库环境文件',
  ENV_FILE: '仓库环境文件',
  FILE: '仓库环境文件',
  WORKSPACE: '上游工作区',
  OUTPUT: '上游输出',
  ARTIFACT: '构建产物',
  CONTEXT: '平台变量',
  PLATFORM: '平台变量',
};

const fieldNames: Record<string, string> = {
  artifact: '部署产物',
  buildLocation: '构建位置',
  buildMode: '构建方式',
  buildCommand: '构建命令',
  buildImage: '构建镜像',
  buildWorkspaceRoot: '构建工作区根目录',
  workspaceRoot: '工作区根目录',
  workingDirectory: '工作目录',
  workDirectory: '工作目录',
  workspace: '工作区',
  directory: '工作目录',
  outputDir: '输出目录',
  installCommand: '依赖安装命令',
  deployMode: '发布方式',
  deployMethod: '发布方式',
  method: '发布方式',
  deployPath: '发布目录',
  composeFile: 'Compose 文件',
  composeFilePath: 'Compose 文件',
  composeSource: 'Compose 来源',
  composeVersion: 'Compose 模板版本',
  composeChecksum: 'Compose 模板 SHA-256',
  composeCommitSha: 'Compose 模板提交',
  dockerfilePath: 'Dockerfile 路径',
  startCommand: '启动命令',
  stopCommand: '停止命令',
  healthCheckCommand: '健康检查命令',
  rollbackStrategy: '回滚策略',
  rollbackMode: '回滚策略',
  rollbackOnFailure: '失败时回滚',
  requireApproval: '发布审批',
  requireCodeReview: '源码审核',
  logRetentionDays: '日志保留天数',
  taskLogRetentionDays: '日志保留天数',
  maxParallel: '最大并发',
  targets: '目标服务器',
  source: '源码',
  variables: '环境变量',
  environment: '环境',
  service: '服务',
};

const valueNames: Record<string, string> = {
  MANAGER: '管理端',
  TARGET: '目标端',
  FILE: '文件',
  COMPOSE: 'Docker Compose',
  DIRECTORY: '目录',
  DOCKER_IMAGE: 'Docker 镜像',
  PARALLEL: '并行',
  SEQUENTIAL: '顺序',
  CONTINUE: '失败后继续',
  STOP: '失败后停止',
};

const sectionNames: Record<string, string> = {
  targets: '目标成员与执行策略',
  buildTargets: '构建目标',
  releaseTargets: '发布目标',
  settings: '配置与策略',
  environmentFiles: '环境文件',
  variables: '变量与敏感引用',
  checkouts: '源码提交',
  artifacts: '部署产物',
  deliveries: '发布配置或产物',
  deferred: '运行时绑定',
  scripts: '脚本位置',
  parameters: '运行参数',
  inputs: '运行参数',
  path: '执行路径',
};

export const planSectionName = (field: string) => sectionNames[field] ?? field;

function settingValue(value: PlanSetting['value']) {
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'string') return valueNames[value] ?? (value || '—');
  return value == null ? '—' : String(value);
}

function names({ project, preview }: { project: ProjectDetail; preview: Preview }) {
  const named = (id: string | undefined, items: { id: string; name: string }[]) =>
    id ? (items.find((item) => item.id === id)?.name ?? id) : '—';
  return {
    node: ({ nodeId, nodeName, flowId, flowName }: NodeScope) => {
      const inRoot = !flowId || flowId === preview.flowId;
      const name =
        nodeName ?? (inRoot ? preview.nodes.find((node) => node.nodeId === nodeId)?.name : nodeId);
      return [inRoot ? undefined : (flowName ?? flowId), name ?? nodeId]
        .filter(Boolean)
        .join(' · ');
    },
    repository: (id?: string) => named(id, project.repositories),
    service: (id?: string) => named(id, project.services),
    environment: (id?: string) => named(id, project.environments),
  };
}

export const sourceName = (source: string) => sourceNames[source] ?? source;

const fieldStates: Record<GraphFieldEvidence['state'], string> = {
  RESOLVED: '已解析',
  DEFERRED: '运行时解析',
  OMITTED: '已省略',
  DEFAULTED: '使用默认值',
  ERROR: '解析失败',
};
const policyNames = {
  ERROR: '缺值报错',
  OMIT: '缺值时省略',
  USE_DEFAULT: '缺值时采用默认值',
  REPOSITORY_DEFAULT: '缺值时采用仓库默认分支',
};

function displayEvidenceValue(
  field: GraphFieldEvidence,
  repositoryName?: (id: string) => string | undefined,
) {
  if (field.sensitive || field.type === 'CREDENTIAL' || field.source?.kind === 'CREDENTIAL')
    return '敏感引用';
  const value = field.value;
  if (field.type === 'REPOSITORY' && typeof value === 'string')
    return repositoryName?.(value) ?? value;
  if (field.type === 'GIT_FETCH_MODE' && (value === 'FULL' || value === 'LATEST'))
    return value === 'FULL' ? '完整拉取' : '拉取最新';
  if (typeof value === 'string') return value === '' ? '空字符串' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length + ' 项';
  if (value && typeof value === 'object') {
    if (
      field.type === 'GIT_REF' &&
      'kind' in value &&
      'value' in value &&
      typeof value.value === 'string'
    )
      return String(value.kind) + ' · ' + value.value;
    if (field.type === 'SOURCE' && 'commitSha' in value && typeof value.commitSha === 'string')
      return value.commitSha;
    return '结构化值';
  }
  return undefined;
}

export function FieldEvidenceList({
  title,
  fields,
  expanded,
  linkSource,
  nameSource,
  repositoryName,
}: {
  title: string;
  fields?: GraphFieldEvidence[];
  expanded?: boolean;
  linkSource?: (source: GraphFieldSource) => string | undefined;
  nameSource?: (id: string) => string | undefined;
  repositoryName?: (id: string) => string | undefined;
}) {
  if (!fields?.length) return null;
  return (
    <details className="graph-field-card" open={expanded}>
      <summary>
        {title} · {fields.length} 项
      </summary>
      <dl className="graph-field-values">
        {fields.map((field) => {
          const source = field.source;
          const href = source && linkSource?.(source);
          const label =
            source &&
            [
              sourceName(source.kind),
              source.nodeId && (nameSource?.(source.nodeId) ?? source.nodeId),
              source.fieldId ?? source.key ?? source.eventField,
              source.transform && (source.transform === 'BRANCH' ? '转为分支' : '转为标签'),
            ]
              .filter(Boolean)
              .join(' · ');
          const value = displayEvidenceValue(field, repositoryName);
          return (
            <div key={field.fieldId}>
              <dt>
                {field.name} <small>{field.type}</small>
              </dt>
              <dd>
                {fieldStates[field.state]}
                {value !== undefined && (
                  <>
                    {' '}
                    · <code>{value}</code>
                  </>
                )}
                {label && (
                  <small>
                    {href ? (
                      <a className="text-link" href={href}>
                        {label}
                      </a>
                    ) : (
                      label
                    )}
                  </small>
                )}
                {field.onMissing && <small>{policyNames[field.onMissing]}</small>}
                {field.message && <small>{field.message}</small>}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
const fieldName = (field: string) => fieldNames[field] ?? field;
const scopeKey = (scope: NodeScope) => `${scope.flowId ?? ''}:${scope.nodeId ?? ''}`;
const targetName = (purpose: PlanTarget['purpose']) =>
  purpose === 'BUILD' ? '构建目标' : '发布目标';

function address(host?: string, port?: number) {
  if (!host) return '';
  if (!port) return host;
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function targetPolicy(target: PlanTarget) {
  if (target.source === 'MANAGER') return '';
  return [
    target.strategy && (valueNames[target.strategy] ?? target.strategy),
    target.maxParallel !== undefined && `最多 ${target.maxParallel} 台并发`,
    target.failurePolicy && (valueNames[target.failurePolicy] ?? target.failurePolicy),
  ]
    .filter(Boolean)
    .join(' · ');
}

function targetGroups(target: PlanTarget) {
  return target.groupIds?.length ? `分组 ${target.groupIds.join('、')}` : '';
}

function fileStatus(file: PlanEnvironmentFile) {
  if (['SKIPPED', 'MISSING', 'ABSENT'].includes(file.status ?? '')) return '未找到可选文件，已跳过';
  if (!file.commitSha) return '在运行中确定';
  return file.required ? '必需 · 已固定' : '可选 · 已固定';
}

function artifactRows(source: Pick<ArtifactChoice, 'artifactIds' | 'artifactRefs'>) {
  return source.artifactRefs?.length
    ? source.artifactRefs
    : (source.artifactIds ?? []).map((id): ArtifactPreview => ({ id }));
}

function artifactChoices(delivery: DeliveryPreview): ArtifactChoice[] {
  if (delivery.possibleArtifacts?.length) {
    return delivery.possibleArtifacts.map((choice) => ({
      flowId: delivery.flowId,
      flowName: delivery.flowName,
      ...choice,
    }));
  }
  if (!delivery.artifactFromNodeId && !artifactRows(delivery).length) return [];
  return [
    {
      ...delivery,
      nodeId: delivery.artifactFromNodeId,
      nodeName: delivery.artifactFromNodeName,
      fieldId: delivery.artifactFromField,
    },
  ];
}

function sourceReviewStatus(source: ArtifactChoice) {
  if (source.sourceReviewPendingMaterialization) return '本次产物登记后按实际仓库及提交复核';
  if (source.sourceReviews?.length) return '已核对产物来源，发布前再次复核';
  return '发布前按产物实际来源复核';
}

type PreviewNames = ReturnType<typeof names>;

function SourceDetails({ source, name }: { source: ArtifactChoice; name: PreviewNames }) {
  return (
    <>
      {source.commitSha && (
        <small>
          关联提交 · <code>{source.commitSha}</code>
        </small>
      )}
      {!!source.sourceSnapshot?.length && (
        <ul className="execution-plan-list" aria-label="仓库与提交">
          {source.sourceSnapshot.map((entry, index) => (
            <li key={`${entry.id ?? entry.repositoryId}:${index}`}>
              {name.repository(entry.repositoryId)}
              {entry.branch && ` · ${entry.branch}`}
              {entry.tag && ` · 标签 ${entry.tag}`} <code>{entry.commitSha}</code>
              {entry.ref && entry.ref !== entry.commitSha && ` · ${entry.ref}`}
              {entry.path && ` · ${entry.path}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function DeliveryArtifacts({
  delivery,
  projectId,
  name,
}: {
  delivery: DeliveryPreview;
  projectId: string;
  name: PreviewNames;
}) {
  const choices = artifactChoices(delivery);
  if (!choices.length) return <SourceDetails source={delivery} name={name} />;
  return (
    <>
      {choices.length > 1 && <strong>可能使用的产物来源</strong>}
      {choices.map((source, index) => (
        <div className="execution-plan-artifact-source" key={index}>
          <strong>{source.nodeId ? '本次执行产出' : '已固定的历史产物'}</strong>
          {source.nodeId && (
            <span>
              {name.node(source)} / <code>{source.fieldId ?? '产物'}</code>
            </span>
          )}
          {artifactRows(source).map((artifact) => (
            <div key={artifact.id}>
              <a
                className="text-link"
                href={
                  '#' +
                  deliveryPath(projectId, 'artifacts', {
                    recordId: artifact.instanceId ?? artifact.artifactId ?? artifact.id,
                  })
                }
              >
                {artifact.name ?? artifact.id}
              </a>
              {(artifact.type || artifact.kind) &&
                ` · ${settingValue((artifact.type ?? artifact.kind)!)}`}
              {artifact.verificationStatus && (
                <span className="tag" title={artifact.verificationReason ?? undefined}>
                  {artifactVerificationLabels[artifact.verificationStatus]}
                </span>
              )}
              {artifact.temporary && <span className="tag">运行内临时产物</span>}
              {(artifact.serverId || artifact.physical?.serverId) && (
                <a
                  className="text-link"
                  href={serverResourceHref({
                    serverId: artifact.serverId ?? artifact.physical?.serverId,
                    projectId,
                    returnPath: window.location.hash.slice(1),
                  })}
                >
                  实物服务器
                </a>
              )}
              {(artifact.physical?.sha256 ||
                artifact.physical?.imageId ||
                artifact.digest ||
                artifact.checksum) && (
                <small>
                  <code>
                    {artifact.imageReference ??
                      (artifact.imageRepository ? artifact.imageRepository + ' · ' : '') +
                        (artifact.physical?.sha256 ??
                          artifact.physical?.imageId ??
                          artifact.digest ??
                          artifact.checksum)}
                  </code>
                </small>
              )}
              {artifact.composeTemplate && (
                <small>
                  Compose 归档 {artifact.composeTemplate.path} ·{' '}
                  <code>{artifact.composeTemplate.checksum}</code>
                </small>
              )}
            </div>
          ))}
          <SourceDetails source={source} name={name} />
          {(delivery.requireCodeReview || !!source.sourceReviews?.length) && (
            <div className="execution-plan-policy">
              <strong>源码审核</strong>
              {delivery.requireCodeReview && <span>{sourceReviewStatus(source)}</span>}
              {!!source.sourceReviews?.length && (
                <ul className="execution-plan-list">
                  {source.sourceReviews.map((review) => (
                    <li key={review.reviewId}>
                      {name.repository(review.repositoryId)} · <code>{review.commitSha}</code> ·
                      审核通过
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ))}
      {delivery.requireApproval && (
        <div className="execution-plan-policy execution-plan-approval">
          <strong>发布审批</strong>
          <span>执行到发布步骤时等待管理员审批</span>
        </div>
      )}
    </>
  );
}

const releaseStepNotes: Record<ReleaseGateKind, string> = {
  SOURCE_REVIEW: '管理员核对实际仓库与固定提交后继续。',
  APPROVAL: '执行到此节点时等待管理员确认。',
  HEALTH_CHECK: '在发布结果关联的目标上执行健康检查并记录状态。',
  ROLLBACK_ARTIFACT: '使用选定的历史产物执行回滚，并保留各目标结果。',
};

function isReleaseGate(type: GraphNode['type']): type is ReleaseGateKind {
  return Object.hasOwn(releaseStepNotes, type);
}

function previewGates(preview: Preview): NonNullable<Preview['gates']> {
  return (
    preview.gates ??
    preview.nodes.flatMap((node) =>
      node.selected !== false && isReleaseGate(node.type)
        ? [{ flowId: preview.flowId, nodeId: node.nodeId, name: node.name, kind: node.type }]
        : [],
    )
  );
}

export function ExecutionPlan({
  preview,
  project,
  returnPath,
  view,
}: {
  preview: Preview;
  project: ProjectDetail;
  returnPath?: string;
  view?: string;
}) {
  const plan = preview.executionPlan;
  const name = names({ project, preview });
  const deliveries = preview.deliveries ?? (preview.serviceId ? [preview] : []);
  const releaseSteps = previewGates(preview);
  return (
    <div className="execution-plan">
      <section>
        <h4>入口变量集合</h4>
        {preview.environmentSet ? (
          <a
            className="text-link"
            href={
              '#' +
              projectResourcePath(project.id, {
                resource: 'environment-sets',
                environmentSetId: preview.environmentSet.id,
                view,
              })
            }
          >
            {preview.environmentSet.name} · 修订 {preview.environmentSet.revision}
          </a>
        ) : (
          <span>使用项目公共变量</span>
        )}
      </section>
      {!!releaseSteps.length && (
        <section>
          <h4>审核与发布步骤</h4>
          {releaseSteps.map((gate) => (
            <div className="execution-plan-row" key={`${gate.flowId}:${gate.nodeId}`}>
              <a
                className="text-link"
                href={
                  '#' +
                  graphWorkbenchPath(project.id, {
                    view,
                    pane: 'published',
                    version: preview.version,
                    flow: gate.flowId,
                    node: gate.nodeId,
                  })
                }
              >
                {gate.name} · {graphNodeLabels[gate.kind]}
              </a>
              <span>{releaseStepNotes[gate.kind]}</span>
              {gate.releaseNodeId && (
                <small>
                  审批范围 · {name.node({ flowId: gate.flowId, nodeId: gate.releaseNodeId })}
                </small>
              )}
              {gate.buildNodeId && (
                <small>
                  审核整个构建的源码 ·{' '}
                  {name.node({ flowId: gate.flowId, nodeId: gate.buildNodeId })}
                </small>
              )}
            </div>
          ))}
        </section>
      )}
      {!!preview.checkouts?.length && (
        <section>
          <h4>源码与检出版本</h4>
          {preview.checkouts.map((checkout, index) => (
            <div className="execution-plan-row" key={`${scopeKey(checkout)}:${index}`}>
              <strong>{name.node(checkout)}</strong>
              <span>
                {checkout.repositoryName ?? name.repository(checkout.repositoryId)} ·{' '}
                {checkout.branch ?? (checkout.tag ? `标签 ${checkout.tag}` : '指定提交')} ·{' '}
                {checkoutModeLabel(checkout)}
              </span>
              <code>{checkout.commitSha}</code>
              {(checkout.ref || checkout.versionSource) && (
                <small>
                  {[checkout.ref, checkout.versionSource && sourceName(checkout.versionSource)]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              )}
              {checkout.triggerCommitSha && (
                <small>
                  触发事件提交 ·{' '}
                  {checkout.triggerRepositoryId && name.repository(checkout.triggerRepositoryId)}{' '}
                  <code>{checkout.triggerCommitSha}</code>
                </small>
              )}
            </div>
          ))}
        </section>
      )}
      {preview.parameterSources && Object.keys(preview.parameterSources).length > 0 && (
        <details className="graph-field-card">
          <summary>开始参数来源</summary>
          <dl className="graph-field-values">
            {Object.entries(preview.parameterSources).map(([id, source]) => (
              <div key={id}>
                <dt>{id}</dt>
                <dd>
                  {sourceName(source.kind)} {source.eventField}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {preview.nodes
        .filter(
          (node) =>
            node.selected !== false &&
            (node.inputs?.length || node.environment?.length || node.outputFields?.length),
        )
        .map((node) => (
          <section key={node.nodeId}>
            <h4>{node.name}</h4>
            <FieldEvidenceList
              title="节点输入"
              fields={node.inputs}
              nameSource={(id) => preview.nodes.find(({ nodeId }) => id === nodeId)?.name}
            />
            <FieldEvidenceList
              title="节点环境绑定"
              fields={node.environment}
              nameSource={(id) => preview.nodes.find(({ nodeId }) => id === nodeId)?.name}
            />
            <FieldEvidenceList
              title="最终输出"
              fields={node.outputFields}
              nameSource={(id) => preview.nodes.find(({ nodeId }) => id === nodeId)?.name}
            />
          </section>
        ))}
      {plan &&
        plan.targets.length > 0 &&
        (['BUILD', 'RELEASE'] as const).map((purpose) => (
          <section key={purpose}>
            <h4>{targetName(purpose)}</h4>
            {plan.targets
              .filter((target) => target.purpose === purpose)
              .map((target, index) => (
                <div key={`${scopeKey(target)}:${index}`} className="execution-plan-row">
                  <div className="execution-plan-heading">
                    <strong>{name.node(target)}</strong>
                    <span className="tag">{sourceName(target.source)}</span>
                  </div>
                  {target.servers.length ? (
                    <ul className="execution-plan-list">
                      {target.servers.map((server) => (
                        <li key={server.id}>
                          <a
                            className="text-link"
                            href={serverResourceHref({
                              serverId: server.id,
                              projectId: project.id,
                              returnPath,
                            })}
                          >
                            {server.name}
                          </a>{' '}
                          {server.host && <code>{address(server.host, server.port)}</code>}
                        </li>
                      ))}
                    </ul>
                  ) : target.source === 'MANAGER' ? (
                    <span>管理端工作区</span>
                  ) : (
                    <span>运行时解析目标</span>
                  )}
                  {!!target.groupIds?.length && (
                    <ul className="execution-plan-list">
                      {target.groupIds.map((groupId) => (
                        <li key={groupId}>
                          <a
                            className="text-link"
                            href={serverResourceHref({
                              groupId,
                              projectId: project.id,
                              returnPath,
                            })}
                          >
                            查看目标分组
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {targetPolicy(target) && <small>{targetPolicy(target)}</small>}
                </div>
              ))}
            {!plan.targets.some((target) => target.purpose === purpose) && (
              <p className="field-note">
                {purpose === 'BUILD' ? '本次路径不解析构建目标。' : '本次路径不解析发布目标。'}
              </p>
            )}
          </section>
        ))}
      {!!plan?.environmentFiles.length && (
        <section>
          <h4>仓库环境文件</h4>
          {plan.environmentFiles.map((file, index) => (
            <div className="execution-plan-row" key={`${scopeKey(file)}:${index}`}>
              <div className="execution-plan-heading">
                <strong>{name.node(file)}</strong>
                <span className="tag">{sourceName(file.source)}</span>
              </div>
              {file.path && <code>{file.path}</code>}
              {file.mappingKey && (
                <small>
                  映射键 · <code>{file.mappingKey}</code>
                </small>
              )}
              <span>{fileStatus(file)}</span>
              {file.repositoryId && (
                <small>
                  {name.repository(file.repositoryId)}
                  {file.branch && ` · ${file.branch}`}
                  {file.tag && ` · 标签 ${file.tag}`}{' '}
                  {file.commitSha && <code>{file.commitSha}</code>}
                </small>
              )}
            </div>
          ))}
        </section>
      )}
      {!!preview.scripts?.length && (
        <section>
          <h4>脚本位置</h4>
          {preview.scripts.map((script, index) => (
            <div className="execution-plan-row" key={`${scopeKey(script)}:${index}`}>
              <strong>{name.node(script)}</strong>
              <span>{script.serverName ?? script.serverId ?? '管理端工作区'}</span>
              <small>
                {preview.environmentSet?.name ??
                  (script.environmentId ? name.environment(script.environmentId) : '项目公共变量')}
                {script.serviceId && ` · ${name.service(script.serviceId)}`}
              </small>
            </div>
          ))}
        </section>
      )}
      {!!plan?.settings.length && (
        <details className="graph-field-card" open>
          <summary>生效配置</summary>
          <dl className="execution-plan-table">
            {plan.settings.map((entry, index) => (
              <div key={`${scopeKey(entry)}:${entry.field}:${index}`}>
                <dt>
                  {fieldName(entry.field)}
                  <small>
                    {name.node(entry)} · {sourceName(entry.source)}
                  </small>
                </dt>
                <dd>
                  <code>{settingValue(entry.value)}</code>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {!!plan?.variables.length && (
        <details className="graph-field-card">
          <summary>生效变量 · {plan.variables.length} 项</summary>
          <dl className="execution-plan-table">
            {plan.variables.map((entry, index) => (
              <div key={`${scopeKey(entry)}:${entry.key}:${index}`}>
                <dt>
                  <code>{entry.key}</code>
                  <small>
                    {name.node(entry)} · {sourceName(entry.source)}
                  </small>
                </dt>
                <dd>
                  {entry.sensitive ? '敏感引用' : (entry.value ?? '普通变量')}
                  {!!entry.overriddenSources?.length && (
                    <small>覆盖 {entry.overriddenSources.map(sourceName).join('、')}</small>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {!!deliveries.length && (
        <section>
          <h4>归档产物与发布条件</h4>
          {deliveries.map((delivery, index) => (
            <div className="execution-plan-row" key={`${scopeKey(delivery)}:${index}`}>
              <strong>{name.node(delivery) || '交付节点'}</strong>
              {(delivery.serviceId || delivery.environmentId) && (
                <small>
                  {[
                    delivery.serviceId && name.service(delivery.serviceId),
                    delivery.environmentId && name.environment(delivery.environmentId),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              )}
              {delivery.method && <small>发布方式 · {settingValue(delivery.method)}</small>}
              {delivery.composeTemplate ? (
                <small>
                  Compose 模板 ·{' '}
                  {delivery.composeTemplate.source === 'REPOSITORY_FILE' ? (
                    <>
                      {name.repository(delivery.composeTemplate.repositoryId)} ·{' '}
                      <code>{delivery.composeTemplate.path}</code> ·{' '}
                      <code>{delivery.composeTemplate.commitSha}</code>
                    </>
                  ) : (
                    '产物存档模板'
                  )}{' '}
                  · SHA-256 <code>{delivery.composeTemplate.checksum}</code>
                </small>
              ) : delivery.composeSource?.kind === 'ARTIFACT' ? (
                <small>读取实际产物中的存档 Compose 模板。</small>
              ) : null}
              <DeliveryArtifacts delivery={delivery} projectId={project.id} name={name} />
              {delivery.rollbackBaseline && Object.keys(delivery.rollbackBaseline).length > 0 && (
                <div className="heading-actions">
                  <small>回滚基线</small>
                  {Object.entries(delivery.rollbackBaseline).map(([serverId, recordId]) => (
                    <a
                      key={serverId}
                      className="text-link"
                      href={'#' + deliveryPath(project.id, 'deployments', { recordId, view })}
                    >
                      {plan?.targets
                        .flatMap(({ servers }) => servers)
                        .find(({ id }) => id === serverId)?.name ?? serverId}
                    </a>
                  ))}
                </div>
              )}
              {!plan?.targets.some((target) => scopeKey(target) === scopeKey(delivery)) &&
                !!delivery.serverIds?.length && (
                  <span>目标服务器 · {delivery.serverIds.join('、')}</span>
                )}
            </div>
          ))}
        </section>
      )}
      {!!plan?.deferred.length && (
        <section>
          <h4>运行中才会取得的值</h4>
          <ul className="execution-plan-list">
            {plan.deferred.map((binding, index) => (
              <li key={`${scopeKey(binding)}:${binding.field}:${index}`}>
                {name.node(binding)} · {fieldName(binding.field)}
                {binding.producerNodeId &&
                  ` ← ${name.node({ ...binding, nodeName: undefined, nodeId: binding.producerNodeId })}`}
                {binding.producerField && ` / ${binding.producerField}`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function reviewRows(preview: Preview, project: ProjectDetail) {
  const plan = preview.executionPlan;
  const name = names({ project, preview });
  const rows = new Map<string, { title: string; value: string }>();
  const add = (category: string, scope: NodeScope, field: string, label: string, value: string) => {
    const key = `${category}:${scopeKey(scope)}:${field}`;
    const title = [name.node(scope), label].filter(Boolean).join(' · ');
    const existing = rows.get(key);
    rows.set(key, { title, value: existing ? `${existing.value}\n${value}` : value });
  };
  add(
    'variables',
    {},
    'environmentSet',
    '入口变量集合',
    preview.environmentSet
      ? `${preview.environmentSet.name} · 修订 ${preview.environmentSet.revision}`
      : '使用项目公共变量',
  );
  for (const target of plan?.targets ?? []) {
    const members = target.servers.map((server) =>
      [server.name, address(server.host, server.port)].filter(Boolean).join(' '),
    );
    add(
      'targets',
      target,
      target.purpose,
      targetName(target.purpose),
      [sourceName(target.source), targetGroups(target), ...members, targetPolicy(target)]
        .filter(Boolean)
        .join(' · '),
    );
  }
  for (const entry of plan?.settings ?? [])
    add(
      'settings',
      entry,
      entry.field,
      fieldName(entry.field),
      `${settingValue(entry.value)} · ${sourceName(entry.source)}`,
    );
  for (const file of plan?.environmentFiles ?? [])
    add(
      'files',
      file,
      'path',
      '环境文件',
      [
        file.path,
        file.mappingKey && `映射键 ${file.mappingKey}`,
        name.repository(file.repositoryId),
        file.commitSha,
        fileStatus(file),
        sourceName(file.source),
      ]
        .filter(Boolean)
        .join(' · '),
    );
  for (const variable of plan?.variables ?? [])
    add(
      'variables',
      variable,
      variable.key,
      variable.key,
      [
        sourceName(variable.source),
        variable.sensitive ? '敏感引用' : (variable.value ?? '普通变量'),
        variable.overriddenSources?.map(sourceName).join('、'),
      ]
        .filter(Boolean)
        .join(' · '),
    );
  for (const checkout of preview.checkouts ?? [])
    add(
      'checkouts',
      checkout,
      'commit',
      '源码与检出方式',
      [
        name.repository(checkout.repositoryId),
        checkout.branch ?? checkout.tag,
        checkout.commitSha,
        checkoutModeLabel(checkout),
      ]
        .filter(Boolean)
        .join(' · '),
    );
  for (const gate of previewGates(preview))
    add(
      'policies',
      { ...gate, nodeName: gate.name },
      gate.kind,
      graphNodeLabels[gate.kind],
      gate.buildNodeId
        ? `构建源码 · ${name.node({ flowId: gate.flowId, nodeId: gate.buildNodeId })}`
        : gate.releaseNodeId
          ? name.node({ flowId: gate.flowId, nodeId: gate.releaseNodeId })
          : releaseStepNotes[gate.kind],
    );
  for (const delivery of preview.deliveries ?? []) {
    for (const [serverId, recordId] of Object.entries(delivery.rollbackBaseline ?? {}))
      add('policies', delivery, `rollback:${serverId}`, '回滚基线', `${serverId} · ${recordId}`);
    const choices = artifactChoices(delivery);
    for (const source of choices) {
      if (source.nodeId)
        add(
          'artifacts',
          delivery,
          'producer',
          '本次执行产出',
          [name.node(source), source.fieldId, source.commitSha].filter(Boolean).join(' · '),
        );
      for (const artifact of artifactRows(source))
        add(
          'artifacts',
          delivery,
          'archive',
          '已固定的历史产物',
          [
            artifact.name,
            artifact.id,
            artifact.type ?? artifact.kind,
            artifact.digest ?? artifact.checksum,
          ]
            .filter(Boolean)
            .join(' · '),
        );
      if (delivery.requireCodeReview)
        add(
          'policies',
          delivery,
          'review',
          '源码审核',
          [
            sourceReviewStatus(source),
            ...(source.sourceReviews ?? []).map(
              ({ repositoryId, commitSha }) => `${name.repository(repositoryId)} · ${commitSha}`,
            ),
          ].join(' · '),
        );
    }
    if (choices.length && delivery.requireApproval)
      add('policies', delivery, 'approval', '发布审批', '需要审批');
  }
  return rows;
}

export function ExecutionPlanChanges({
  previous,
  current,
  sections,
  project,
}: {
  previous: Preview;
  current?: Preview;
  sections: string[];
  project: ProjectDetail;
}) {
  const changed = new Set(sections.map(planSectionName));
  if (previous.planSections && current?.planSections) {
    for (const field of new Set([
      ...Object.keys(previous.planSections),
      ...Object.keys(current.planSections),
    ])) {
      if (previous.planSections[field] !== current.planSections[field])
        changed.add(planSectionName(field));
    }
  }
  const before = reviewRows(previous, project);
  const after = current && reviewRows(current, project);
  const rows = after
    ? [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
        const previous = before.get(key);
        const next = after.get(key);
        if (previous?.value === next?.value) return [];
        return [
          {
            key,
            title: next?.title ?? previous?.title,
            before: previous?.value ?? '未设置',
            after: next?.value ?? '已移除',
          },
        ];
      })
    : [];
  return (
    <div className="execution-plan-changes" role="status">
      <strong>{current ? '与上一次预览相比' : '执行计划已变化'}</strong>
      {changed.size > 0 && <p>涉及 {Array.from(changed).join('、')}</p>}
      {rows.length > 0 && (
        <ul className="execution-plan-list">
          {rows.map((row) => (
            <li key={row.key}>
              <strong>{row.title}</strong>
              <dl className="execution-plan-before-after">
                <div>
                  <dt>原计划</dt>
                  <dd>{row.before}</dd>
                </div>
                <div>
                  <dt>新计划</dt>
                  <dd>{row.after}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <p>{current ? '请核对新计划后确认启动。' : '请重新预览，再确认启动。'}</p>
    </div>
  );
}
