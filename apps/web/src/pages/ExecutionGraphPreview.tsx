import type { ProjectDetail } from '../models';
import type { GraphNode } from './execution-graph-definition';
import { deliveryPath } from './delivery-route';
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
}

interface PlanVariable extends NodeScope {
  key: string;
  source: string;
  sensitive: boolean;
}

interface DeferredBinding extends NodeScope {
  field: string;
  producerNodeId?: string;
  producerField?: string;
}

interface ArtifactPreview {
  id: string;
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

interface DeliveryPreview extends NodeScope {
  artifactFromNodeId?: string;
  artifactFromField?: string;
  environmentId?: string;
  commitSha?: string;
  serverIds?: string[];
  artifactIds?: string[];
  artifactRefs?: ArtifactPreview[];
  requireApproval?: boolean;
  requireCodeReview?: boolean;
  sourceReviews?: { repositoryId: string; commitSha: string; reviewId: string }[] | null;
  sourceReviewPendingMaterialization?: boolean;
  possibleArtifacts?: {
    nodeId?: string;
    fieldId?: string;
    commitSha: string;
    artifactIds: string[];
  }[];
  serviceId?: string;
  sourceSnapshot?: {
    id?: string;
    repositoryId: string;
    branch?: string;
    tag?: string;
    ref?: string;
    path?: string;
    commitSha: string;
  }[];
}

export interface Preview extends DeliveryPreview {
  configurationHash: string;
  planSections?: Record<string, string>;
  version: number;
  flowId: string;
  parameters?: Record<string, unknown>;
  nodes: { nodeId: string; name: string; type: GraphNode['type']; selected?: boolean }[];
  deliveries?: DeliveryPreview[];
  checkouts?: (NodeScope & {
    repositoryId: string;
    branch?: string;
    tag?: string;
    commitSha: string;
    fullClone: boolean;
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

const sourceNames: Record<string, string> = {
  RUN_INPUT: '运行参数',
  INPUT: '运行参数',
  NODE: '节点配置',
  SYSTEM: '系统默认',
  SYSTEM_DEFAULT: '系统默认',
  PROJECT: '项目配置',
  PROJECT_DEFAULT: '项目默认',
  SERVICE_ENVIRONMENT: '服务环境覆盖',
  PROJECT_ENVIRONMENT: '项目环境默认',
  ENVIRONMENT: '项目环境',
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
  deployPath: '发布目录',
  composeFile: 'Compose 文件',
  composeFilePath: 'Compose 文件',
  composeSource: 'Compose 来源',
  composeVersion: 'Compose 模板版本',
  composeChecksum: 'Compose 模板 SHA-256',
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

const sourceName = (source: string) => sourceNames[source] ?? source;
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
  if (['SKIPPED', 'MISSING', 'ABSENT'].includes(file.status ?? '')) return '未找到约定文件，已跳过';
  if (!file.commitSha) return '在运行中确定';
  return file.required ? '必需 · 已固定' : '可选 · 已固定';
}

function artifactRows(delivery: DeliveryPreview) {
  return delivery.artifactRefs?.length
    ? delivery.artifactRefs
    : (delivery.artifactIds ?? []).map((id): ArtifactPreview => ({ id }));
}

export function ExecutionPlan({ preview, project }: { preview: Preview; project: ProjectDetail }) {
  const plan = preview.executionPlan;
  const name = names({ project, preview });
  const deliveries = preview.deliveries ?? (preview.serviceId ? [preview] : []);
  return (
    <div className="execution-plan">
      {!!preview.checkouts?.length && (
        <section>
          <h4>源码与检出版本</h4>
          {preview.checkouts.map((checkout, index) => (
            <div className="execution-plan-row" key={`${scopeKey(checkout)}:${index}`}>
              <strong>{name.node(checkout)}</strong>
              <span>
                {name.repository(checkout.repositoryId)} ·{' '}
                {checkout.branch ?? (checkout.tag ? `标签 ${checkout.tag}` : '指定提交')} ·{' '}
                {checkout.fullClone ? '完整历史' : '浅拉取'}
              </span>
              <code>{checkout.commitSha}</code>
            </div>
          ))}
        </section>
      )}
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
                          {server.name}{' '}
                          {server.host && <code>{address(server.host, server.port)}</code>}
                        </li>
                      ))}
                    </ul>
                  ) : target.source === 'MANAGER' ? (
                    <span>管理端工作区</span>
                  ) : (
                    <span>运行时解析目标</span>
                  )}
                  {targetGroups(target) && <small>{targetGroups(target)}</small>}
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
                {script.environmentId ? name.environment(script.environmentId) : '项目公共变量'}
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
                <dd>{entry.sensitive ? '敏感引用' : '普通变量'}</dd>
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
              {artifactRows(delivery).map((artifact) => (
                <div key={artifact.id}>
                  已固定 ·{' '}
                  <a
                    className="text-link"
                    href={'#' + deliveryPath(project.id, 'artifacts', { recordId: artifact.id })}
                  >
                    {artifact.name ?? artifact.id}
                  </a>
                  {(artifact.type || artifact.kind) &&
                    ` · ${settingValue((artifact.type ?? artifact.kind)!)}`}
                  {(artifact.digest || artifact.checksum) && (
                    <small>
                      <code>
                        {artifact.imageReference ??
                          ((artifact.imageRepository ? artifact.imageRepository + ' · ' : '') +
                            (artifact.digest ?? artifact.checksum))}
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
              {delivery.possibleArtifacts?.length ? (
                <ul className="execution-plan-list" aria-label="可能使用的产物来源">
                  {delivery.possibleArtifacts.map((candidate, index) => (
                    <li key={index}>
                      {candidate.nodeId
                        ? `运行中产出 · ${name.node({ ...delivery, nodeName: undefined, nodeId: candidate.nodeId })} / ${candidate.fieldId ?? '产物'}`
                        : candidate.artifactIds.join('、')}{' '}
                      <code>{candidate.commitSha}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                delivery.artifactFromNodeId && (
                  <span>
                    运行中产出 ·{' '}
                    {name.node({
                      ...delivery,
                      nodeName: undefined,
                      nodeId: delivery.artifactFromNodeId,
                    })}{' '}
                    / {delivery.artifactFromField ?? '产物'}
                  </span>
                )
              )}
              {delivery.commitSha && (
                <small>
                  关联提交 · <code>{delivery.commitSha}</code>
                </small>
              )}
              {!!delivery.sourceSnapshot?.length && (
                <ul className="execution-plan-list">
                  {delivery.sourceSnapshot.map((source, index) => (
                    <li key={`${source.id ?? source.repositoryId}:${index}`}>
                      {name.repository(source.repositoryId)}
                      {source.branch && ` · ${source.branch}`}
                      {source.tag && ` · 标签 ${source.tag}`} <code>{source.commitSha}</code>
                      {source.ref && source.ref !== source.commitSha && ` · ${source.ref}`}
                      {source.path && ` · ${source.path}`}
                    </li>
                  ))}
                </ul>
              )}
              {!plan?.targets.some((target) => scopeKey(target) === scopeKey(delivery)) &&
                !!delivery.serverIds?.length && (
                  <span>目标服务器 · {delivery.serverIds.join('、')}</span>
                )}
              {delivery.requireApproval && <span className="field-note">发布需要管理员审批</span>}
              {delivery.requireCodeReview && (
                <>
                  <span className="field-note">
                    {delivery.sourceReviewPendingMaterialization
                      ? '源码审核 · 登记本次产物后按其实际来源复核'
                      : delivery.sourceReviews?.length
                        ? '源码审核 · 已核对产物来源，发布前再次复核'
                        : '源码审核 · 发布前按产物实际来源复核'}
                  </span>
                  {!!delivery.sourceReviews?.length && (
                    <ul className="execution-plan-list">
                      {delivery.sourceReviews.map((review) => (
                        <li key={review.reviewId}>
                          {name.repository(review.repositoryId)} · <code>{review.commitSha}</code> ·
                          审核通过
                        </li>
                      ))}
                    </ul>
                  )}
                </>
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
      `${sourceName(variable.source)} · ${variable.sensitive ? '敏感引用' : '普通变量'}`,
    );
  for (const checkout of preview.checkouts ?? [])
    add(
      'checkouts',
      checkout,
      'commit',
      '源码提交',
      [name.repository(checkout.repositoryId), checkout.branch ?? checkout.tag, checkout.commitSha]
        .filter(Boolean)
        .join(' · '),
    );
  for (const delivery of preview.deliveries ?? []) {
    for (const artifact of artifactRows(delivery))
      add(
        'artifacts',
        delivery,
        'archive',
        '固定产物',
        [artifact.id, artifact.type ?? artifact.kind, artifact.digest ?? artifact.checksum]
          .filter(Boolean)
          .join(' · '),
      );
    for (const candidate of delivery.possibleArtifacts ?? [])
      add(
        'artifacts',
        delivery,
        'candidate',
        '产物来源',
        [candidate.nodeId, candidate.fieldId, ...candidate.artifactIds, candidate.commitSha]
          .filter(Boolean)
          .join(' · '),
      );
    if (delivery.requireApproval !== undefined)
      add(
        'policies',
        delivery,
        'approval',
        '发布审批',
        delivery.requireApproval ? '需要审批' : '无需审批',
      );
    if (delivery.requireCodeReview !== undefined)
      add(
        'policies',
        delivery,
        'review',
        '源码审核',
        delivery.sourceReviewPendingMaterialization
          ? '等待产物登记'
          : delivery.requireCodeReview
            ? '需要审核'
            : '无需审核',
      );
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
