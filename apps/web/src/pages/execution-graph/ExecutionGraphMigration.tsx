import { useState, type FormEvent } from 'react';
import { message, post, useResource } from '../../api';
import { Confirm, ErrorBanner, Field, Form, Loading, Section } from '../../components';
import type { DeploymentSelection, ProjectDetail, User } from '../../models';
import { DeploymentSelectionPicker, useDeploymentInventory } from '../delivery/DeploymentSelection';
import { graphWorkbenchPath } from './graph-workbench-context';
import './execution-graph-migration.css';

type Comparison = {
  environmentId?: string;
  commitSha?: string;
  serverIds?: string[];
  groupIds?: string[];
  artifactId?: string;
  targetId?: string;
  value?: string;
};
type PlanTarget = {
  source: string;
  serverIds: string[];
  legacyTargetId?: string;
  strategy?: string;
};
type PlanSummary = {
  mode?: string;
  serviceId?: string;
  environmentId?: string;
  buildLocation?: string;
  repositoryId?: string;
  branch?: string;
  commitSha?: string;
  artifactType?: string;
  artifactId?: string;
  targetSource?: string;
  serverIds?: string[];
  targets?: { build?: PlanTarget; release?: PlanTarget };
  environmentFile?: string;
  workingDirectory?: string;
  deployPath?: string;
  buildCommandSource?: string;
  requireCodeReview?: boolean;
  requireReleaseApproval?: boolean;
  variables?: { key: string; source: string; sensitive: boolean }[];
  steps: { id: string; type: string }[];
};
type MigrationPlan = {
  planHash: string;
  status: 'MISSING' | 'LEGACY_DRAFT' | 'PRESERVED_DRAFT' | 'STAGED' | 'CURRENT';
  graphId: string | null;
  revision: number | null;
  publishedVersion: number | null;
  issues: { id: string; code: string; message: string; flowId?: string; blocking: boolean }[];
  comparison: {
    flowId: string;
    name: string;
    before?: PlanSummary;
    after?: PlanSummary;
    differences: string[];
  }[];
  versions: { version: number; legacy: boolean; retired: boolean; pendingRuns: number }[];
  triggers: {
    id: string;
    name: string;
    kind: string;
    flowId: string;
    version: number;
    enabled: boolean;
    pendingEvents: number;
  }[];
  artifactCount: number;
  legacyReviewCount: number;
  legacyPipelines: { id: string; name: string; version: number; webhookEnabled: boolean }[];
  legacyTargets: { id: string; name: string; strategy: string; serverIds: string[] }[];
  lastCutover?: {
    id: string;
    targetVersion: number;
    triggers: { id: string; previousVersion: number }[];
    restored: boolean;
  };
};

const planLabels = {
  MISSING: '缺少执行图',
  LEGACY_DRAFT: '检测到旧交付预设',
  PRESERVED_DRAFT: '存在需保留的草稿',
  STAGED: '迁移草稿已准备',
  CURRENT: '当前草稿使用功能节点',
};

export function ExecutionGraphMigration({
  project,
  user,
  view,
}: {
  project: ProjectDetail;
  user: User;
  view?: string;
}) {
  const path = `/projects/${encodeURIComponent(project.id)}/execution-graph/migration`;
  const savedPlan = useResource<MigrationPlan>(path);
  const [preview, setPreview] = useState<{ plan: MigrationPlan; input: Comparison }>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<'cutover' | 'restore'>();
  const plan = preview?.plan ?? savedPlan.data;
  const editable = user.role === 'ADMIN';
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [triggerIds, setTriggerIds] = useState<string[]>([]);
  const graphHref = (pane: 'draft' | 'history') =>
    '#' + graphWorkbenchPath(project.id, { view, pane });

  async function perform(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (issue) {
      setError(message(issue));
    } finally {
      setBusy(false);
    }
  }
  function reload() {
    setPreview(undefined);
    setAcknowledged([]);
    setTriggerIds([]);
    void savedPlan.reload();
  }
  async function compare(input: Comparison) {
    await perform(async () => {
      setPreview({ plan: await post<MigrationPlan>(path + '/preview', input), input });
      setAcknowledged([]);
      setTriggerIds([]);
    });
  }
  if (savedPlan.loading && !plan) return <Loading />;
  if (!plan) return <ErrorBanner error={savedPlan.error} retry={savedPlan.reload} />;
  const legacyVersions = new Set(
    plan.versions.filter(({ legacy }) => legacy).map(({ version }) => version),
  );
  const triggers = plan.triggers.filter(({ version }) => legacyVersions.has(version));
  const proposedVersion = plan.versions.find(
    ({ version, legacy, retired }) => version === plan.publishedVersion && !legacy && !retired,
  )?.version;
  const stageable = plan.status === 'MISSING' || plan.status === 'LEGACY_DRAFT';
  const allAcknowledged = plan.issues.every(
    ({ id, blocking }) => !blocking && acknowledged.includes(id),
  );
  const previousCutover =
    plan.lastCutover && !plan.lastCutover.restored ? plan.lastCutover : undefined;

  async function confirm() {
    await perform(async () => {
      if (action === 'cutover' && savedPlan.data) {
        await post(path + '/cutover', {
          planHash: savedPlan.data.planHash,
          targetVersion: proposedVersion,
          triggerIds,
          confirmed: true,
        });
        setNotice('已切换选中的触发器。');
      } else if (action === 'restore' && previousCutover) {
        const result = await post<{ suspendedTriggerIds: string[] }>(path + '/restore', {
          cutoverId: previousCutover.id,
          confirmed: true,
        });
        setNotice(
          result.suspendedTriggerIds.length
            ? `已恢复触发器配置。其中 ${result.suspendedTriggerIds.length} 个旧入口已停用，等待人工核对。`
            : '已恢复原触发器。',
        );
      }
      setAction(undefined);
      reload();
    });
  }

  return (
    <div className="execution-migration">
      <ErrorBanner error={savedPlan.error || (!action ? error : '')} retry={reload} />
      {notice && (
        <p className="success-notice" role="status">
          {notice}
        </p>
      )}
      <Section
        title="执行图迁移"
        subtitle="盘点旧交付入口，用相同输入对照计划，再发布草稿并切换触发器。"
        action={
          <a className="button secondary small" href={graphHref('history')}>
            返回运行记录
          </a>
        }
      >
        <div className="migration-summary">
          <strong>{planLabels[plan.status]}</strong>
          <span>草稿修订 {plan.revision ?? '—'}</span>
          <span>发布版本 {plan.publishedVersion ?? '—'}</span>
          <span>历史制品 {plan.artifactCount} 件</span>
        </div>
        <MigrationComparison
          project={project}
          busy={busy}
          onCompare={compare}
          targets={plan.legacyTargets}
        />
      </Section>
      {(plan.versions.length > 0 ||
        plan.legacyTargets.length > 0 ||
        plan.legacyPipelines.length > 0 ||
        plan.legacyReviewCount > 0) && (
        <Section title="存量记录">
          <div className="form-body">
            {plan.versions.length > 0 && (
              <ul>
                {plan.versions.map(({ version, legacy, retired, pendingRuns }) => (
                  <li key={version}>
                    v{version} · {legacy ? '旧交付入口' : '功能节点'} ·{' '}
                    {retired ? '已停用' : '可用版本'} · {pendingRuns} 个在途运行
                  </li>
                ))}
              </ul>
            )}
            {plan.legacyPipelines.length > 0 && (
              <ul>
                {plan.legacyPipelines.map(({ id, name, version, webhookEnabled }) => (
                  <li key={id}>
                    {name} · 旧 Pipeline v{version} · Webhook {webhookEnabled ? '已启用' : '已停用'}
                  </li>
                ))}
              </ul>
            )}
            {plan.legacyTargets.length > 0 && (
              <ul>
                {plan.legacyTargets.map(({ id, name, strategy, serverIds }) => (
                  <li key={id}>
                    {name} · 旧目标 · {strategy} · {serverIds.length} 台
                  </li>
                ))}
              </ul>
            )}
            {plan.legacyReviewCount > 0 && (
              <p>已保留 {plan.legacyReviewCount} 条旧 SHA 审核记录。</p>
            )}
          </div>
        </Section>
      )}
      {(plan.comparison.length > 0 || plan.issues.length > 0 || stageable) && (
        <Section title="映射与差异">
          <div className="form-body">
            {plan.comparison.map((flow) => (
              <details
                className="advanced-options"
                key={flow.flowId}
                open={plan.comparison.length === 1}
              >
                <summary>{flow.name}</summary>
                <div className="migration-compare">
                  <Summary title="原计划" summary={flow.before} project={project} />
                  <Summary title="迁移计划" summary={flow.after} project={project} />
                </div>
                {flow.differences.length ? (
                  <ul>
                    {flow.differences.map((diff) => (
                      <li key={diff}>{diff}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">当前输入下没有检测到差异。</p>
                )}
              </details>
            ))}
            {plan.issues.map((issue) => (
              <div className="migration-issue" key={issue.id}>
                {issue.blocking ? (
                  <span className="tag">阻止迁移</span>
                ) : stageable && editable ? (
                  <input
                    type="checkbox"
                    id={'migration-' + issue.id}
                    checked={acknowledged.includes(issue.id)}
                    onChange={(event) =>
                      setAcknowledged(
                        event.target.checked
                          ? [...acknowledged, issue.id]
                          : acknowledged.filter((id) => id !== issue.id),
                      )
                    }
                  />
                ) : (
                  <span className="tag">需核对</span>
                )}
                <label htmlFor={'migration-' + issue.id}>{issue.message}</label>
              </div>
            ))}
            {stageable && editable && (
              <button
                className="button primary"
                type="button"
                disabled={busy || !allAcknowledged}
                onClick={() =>
                  void perform(async () => {
                    await post(path + '/stage', {
                      planHash: plan.planHash,
                      acknowledgements: acknowledged,
                      comparison: preview?.input,
                    });
                    setNotice('迁移草稿已准备，请在画布核对并发布。');
                    reload();
                  })
                }
              >
                准备迁移草稿
              </button>
            )}
            {(plan.status === 'STAGED' || plan.status === 'PRESERVED_DRAFT') && (
              <a className="button secondary" href={graphHref('draft')}>
                打开草稿
              </a>
            )}
          </div>
        </Section>
      )}
      {triggers.length > 0 && (
        <Section
          title="切换旧入口的触发器"
          subtitle="选择需要切换且已无待处理事件的触发器。等待中的运行继续使用原版本。"
        >
          <div className="form-body">
            {triggers.map((trigger) => (
              <label key={trigger.id} className="checkbox-row">
                <input
                  type="checkbox"
                  disabled={!editable || busy || !proposedVersion || !!trigger.pendingEvents}
                  checked={triggerIds.includes(trigger.id)}
                  onChange={(event) =>
                    setTriggerIds(
                      event.target.checked
                        ? [...triggerIds, trigger.id]
                        : triggerIds.filter((id) => id !== trigger.id),
                    )
                  }
                />
                <span>
                  {trigger.name} · {trigger.kind} · v{trigger.version} ·{' '}
                  {trigger.enabled ? '已启用' : '已停用'} · {trigger.pendingEvents} 个待处理事件
                </span>
              </label>
            ))}
            {!proposedVersion && <p className="field-note">发布迁移后的图版本后可切换触发器。</p>}
            {editable && (
              <button
                className="button primary"
                type="button"
                disabled={busy || !proposedVersion || !triggerIds.length}
                onClick={() => {
                  setError('');
                  setAction('cutover');
                }}
              >
                切换选中的触发器
              </button>
            )}
          </div>
        </Section>
      )}
      {previousCutover && (
        <Section
          title="最近一次切换"
          subtitle={`目标版本 v${previousCutover.targetVersion} · ${previousCutover.triggers.length} 个触发器`}
        >
          {editable && (
            <div className="form-body">
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setAction('restore');
                }}
              >
                恢复原触发器
              </button>
            </div>
          )}
        </Section>
      )}
      {action && (
        <Confirm
          title={action === 'cutover' ? '确认切换触发器' : '确认恢复原触发器'}
          description={
            action === 'cutover'
              ? `将 ${triggerIds.length} 个触发器切换到 v${proposedVersion}。历史事件和运行保留在原版本。`
              : '恢复最近一次切换保存的触发器配置。旧入口需要人工复核时，恢复后的触发器会停用。'
          }
          label={action === 'cutover' ? '切换' : '恢复'}
          error={error}
          busy={busy}
          onClose={() => !busy && setAction(undefined)}
          onConfirm={confirm}
        />
      )}
    </div>
  );
}

function MigrationComparison({
  project,
  busy,
  onCompare,
  targets,
}: {
  project: ProjectDetail;
  busy: boolean;
  onCompare: (input: Comparison) => Promise<void>;
  targets: MigrationPlan['legacyTargets'];
}) {
  const inventory = useDeploymentInventory();
  const [selection, setSelection] = useState<DeploymentSelection>({});
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim() || undefined;
    const explicitTargets = Boolean(selection.serverIds?.length || selection.groupIds?.length);
    await onCompare({
      environmentId: value('environmentId'),
      commitSha: value('commitSha'),
      artifactId: value('artifactId'),
      targetId: explicitTargets ? undefined : value('targetId'),
      value: value('value'),
      serverIds: selection.serverIds?.length ? selection.serverIds : undefined,
      groupIds: selection.groupIds?.length ? selection.groupIds : undefined,
    });
  }
  return (
    <Form onSubmit={submit} busy={busy} submit="对照新旧计划">
      <div className="form-grid">
        <Field label="对照环境">
          <select name="environmentId">
            <option value="">使用原设置</option>
            {project.environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="固定提交">
          <input
            name="commitSha"
            pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}"
            placeholder="完整 SHA"
          />
        </Field>
        <Field label="历史产物">
          <input name="artifactId" maxLength={36} placeholder="产物 ID" />
        </Field>
      </div>
      <details className="advanced-options">
        <summary>指定对照目标</summary>
        {targets.length > 0 && (
          <Field label="旧部署目标">
            <select name="targetId">
              <option value="">使用原设置</option>
              {targets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <DeploymentSelectionPicker
          projectId={project.id}
          inventory={inventory}
          value={selection}
          onChange={setSelection}
          disabled={busy}
        />
      </details>
      <Field label="条件输入样本">
        <input name="value" maxLength={500} />
      </Field>
    </Form>
  );
}

function Summary({
  title,
  summary,
  project,
}: {
  title: string;
  summary?: PlanSummary;
  project: ProjectDetail;
}) {
  if (!summary)
    return (
      <div>
        <strong>{title}</strong>
        <p className="muted">暂无可对照的计划。</p>
      </div>
    );
  const rows = [
    ['模式', summary.mode],
    [
      '服务',
      project.services.find(({ id }) => id === summary.serviceId)?.name ?? summary.serviceId,
    ],
    [
      '环境',
      project.environments.find(({ id }) => id === summary.environmentId)?.name ??
        summary.environmentId,
    ],
    [
      '源码',
      project.repositories.find(({ id }) => id === summary.repositoryId)?.name ??
        summary.repositoryId,
    ],
    ['分支与提交', [summary.branch, summary.commitSha].filter(Boolean).join(' · ')],
    ['构建位置', summary.buildLocation],
    ['制品', [summary.artifactType, summary.artifactId].filter(Boolean).join(' · ')],
    ['环境文件', summary.environmentFile],
    ['工作目录', summary.workingDirectory],
    ['发布目录', summary.deployPath],
    [
      '构建命令来源',
      summary.buildCommandSource === 'NODE'
        ? '节点'
        : summary.buildCommandSource === 'SERVICE_ENVIRONMENT'
          ? '服务环境'
          : undefined,
    ],
    ['源码审核', summary.requireCodeReview ? '必需' : undefined],
    ['发布审批', summary.requireReleaseApproval ? '必需' : undefined],
    ['构建目标', targetsText(summary.targets?.build)],
    [
      '发布目标',
      targetsText(summary.targets?.release) ||
        [summary.targetSource, ...(summary.serverIds ?? [])].filter(Boolean).join(' · '),
    ],
    [
      '变量',
      summary.variables
        ?.map((item) => `${item.key}（${item.source}${item.sensitive ? ' · 敏感' : ''}）`)
        .join('、'),
    ],
    ['步骤', summary.steps.map((step) => step.type).join(' → ')],
  ];
  return (
    <div>
      <strong>{title}</strong>
      <dl>
        {rows
          .filter(([, value]) => value)
          .map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

function targetsText(target?: PlanTarget) {
  return (
    target &&
    [target.source, target.strategy, target.legacyTargetId, ...target.serverIds]
      .filter(Boolean)
      .join(' · ')
  );
}
