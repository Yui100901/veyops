import type { ExecutionPlanIssue } from '../../../api';
import type { GraphSetupIssue } from './ExecutionGraphRepairLinks';
import { deliveryPath, type DeliveryScope } from '../../delivery/delivery-route';

export function repairKind(code: ExecutionPlanIssue['code']): GraphSetupIssue['kind'] | undefined {
  if (code === 'RELEASE_TARGET') return 'DEPLOY_TARGET';
  if (code === 'REPOSITORY' || code === 'BUILD_TARGET' || code === 'ARTIFACT') return code;
}

export const planIssueLabels: Record<ExecutionPlanIssue['code'], string> = {
  INPUT: '运行参数有待处理',
  REPOSITORY: '仓库有待处理',
  BUILD_TARGET: '构建目标有待处理',
  RELEASE_TARGET: '发布目标有待处理',
  ARTIFACT: '产物有待处理',
  SOURCE_REVIEW: '源码审核有待处理',
  CONFIGURATION: '执行配置有待处理',
};

export function artifactOutput(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  if ('temporaryArtifactId' in value && typeof value.temporaryArtifactId === 'string')
    return { id: value.temporaryArtifactId, label: '查看临时产物', temporary: true };
  if ('artifactId' in value && typeof value.artifactId === 'string') {
    const instances =
      'instances' in value && Array.isArray(value.instances) ? value.instances : undefined;
    const temporary = 'scope' in value && value.scope === 'TEMPORARY';
    const firstInstance = instances?.[0] as { instanceId?: string } | undefined;
    return {
      id: temporary ? (firstInstance?.instanceId ?? value.artifactId) : value.artifactId,
      label: 'name' in value && typeof value.name === 'string' ? value.name : '查看产物',
      temporary,
      instances,
    };
  }
  return undefined;
}

export function GraphRunResults({
  values,
  labels = {},
  omit = [],
  title,
  expanded,
  artifactContext,
}: {
  values?: Record<string, unknown>;
  labels?: Record<string, string>;
  omit?: string[];
  title: string;
  expanded?: boolean;
  artifactContext?: { projectId: string; scope: DeliveryScope };
}) {
  const rows = Object.entries(values ?? {}).filter(
    ([name]) =>
      ![
        ...omit,
        'decision',
        'wakeAt',
        'expiresAt',
        'decidedAt',
        'secretVariables',
        'secretCredentialNonces',
        'variables',
      ].includes(name),
  );
  if (!rows.length) return null;
  return (
    <details className="graph-field-card" open={expanded}>
      <summary>{title}</summary>
      <dl className="graph-field-values">
        {rows.map(([name, value]) => {
          const references = (Array.isArray(value) ? value : [value]).map(artifactOutput);
          return (
            <div key={name}>
              <dt>{labels[name] ?? name}</dt>
              <dd>
                {artifactContext && references.length > 0 && references.every(Boolean) ? (
                  <div className="heading-actions">
                    {references.map(
                      (reference, index) =>
                        reference && (
                          <div key={reference.id + ':' + index}>
                            <a
                              className="button secondary small"
                              href={
                                '#' +
                                deliveryPath(artifactContext.projectId, 'artifacts', {
                                  ...artifactContext.scope,
                                  recordId: reference.id,
                                })
                              }
                            >
                              {reference.label}
                              {reference.temporary && <span className="tag">临时</span>}
                            </a>
                            {!!reference.instances?.length && (
                              <details>
                                <summary>逐目标实例（{reference.instances.length}）</summary>
                                <pre>{JSON.stringify(reference.instances, null, 2)}</pre>
                              </details>
                            )}
                          </div>
                        ),
                    )}
                  </div>
                ) : typeof value === 'object' ? (
                  <pre>{JSON.stringify(value, null, 2)}</pre>
                ) : (
                  String(value)
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
