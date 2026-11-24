import { Field } from '../../../components';
import type { ProjectDetail } from '../../../models';
import type { GraphBinding, GraphNode, GraphStartGroup } from '../execution-graph-definition';
import {
  getGraphStartGroups,
  graphStartGroupCompanion,
  graphStartGroupDetails,
  graphStartGroupFields,
  isGraphSharedReleaseTarget,
  selectedGraphStartGroup,
  type GraphStartGroupKind,
  type GraphTargetNames,
} from './graph-start-groups';

export function ExecutionGraphGroupSelection({
  kind,
  start,
  catalogGroups,
  bindings,
  project,
  targetNames,
  canEdit,
  change,
  openStart,
}: {
  kind: GraphStartGroupKind;
  start: GraphNode;
  catalogGroups?: GraphStartGroup[];
  bindings?: Record<string, GraphBinding>;
  project: ProjectDetail;
  targetNames?: GraphTargetNames;
  canEdit: boolean;
  change: (groupId?: string) => void;
  openStart?: (nodeId: string, fieldId: string) => void;
}) {
  const config = graphStartGroupFields[kind];
  const groups = getGraphStartGroups(start, kind, catalogGroups);
  const paired = bindings?.[config.pairedInput];
  const selected = selectedGraphStartGroup(kind, groups, bindings);
  const fieldId = selected?.primary.id ?? groups[0]?.primary.id ?? config.primary;
  const companion = selected && graphStartGroupCompanion(start, kind, groups, selected, paired);
  const details = selected
    ? graphStartGroupDetails(kind, { ...selected, companion }, project, targetNames)
    : [];
  const legacyPair = paired && !isGraphSharedReleaseTarget(kind, groups, paired);
  const invalid = !selected && Boolean(bindings?.[config.input] || paired);
  return (
    <section className="graph-inspector-port" aria-label={config.label}>
      <div data-graph-node-field={config.pairedInput}>
        <div data-graph-node-field={config.input}>
          {groups.length > 1 || invalid ? (
            <Field label={config.label}>
              <select
                disabled={!canEdit}
                value={selected?.id ?? ''}
                onChange={(event) => change(event.target.value || undefined)}
              >
                <option value="">选择{config.label}</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {[
                      group.label,
                      ...graphStartGroupDetails(kind, group, project, targetNames),
                    ].join(' · ')}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <strong>{config.label}</strong>
          )}
        </div>
      </div>
      {invalid ? (
        <p className="field-note">原有绑定无法组成有效的{config.label}。请选择同一组配置。</p>
      ) : selected && !companion ? (
        <p className="field-note">
          所选{config.label}缺少{kind === 'source' ? '版本' : '目标'}字段，请在开始节点补齐。
        </p>
      ) : selected ? (
        <p className="field-note">
          {groups.length === 1 && !bindings?.[config.input] && '自动使用唯一'}
          {[selected.label, ...details].join(' · ')}
        </p>
      ) : !groups.length ? (
        <p className="field-note">请在当前开始节点配置{config.label}。</p>
      ) : null}
      <div className="row-actions">
        {openStart && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => openStart(start.id, fieldId)}
          >
            {canEdit ? '打开开始配置' : '查看开始配置'}
          </button>
        )}
        {canEdit && selected && legacyPair && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => change(selected.id)}
          >
            保存为组合选择
          </button>
        )}
        {canEdit && invalid && !groups.length && (
          <button className="button secondary small" type="button" onClick={() => change()}>
            清除原有绑定
          </button>
        )}
      </div>
    </section>
  );
}
