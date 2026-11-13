import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link2, Network, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, message, post, remove, useResource } from '../api';
import { Confirm, ErrorBanner, Field, Form, Modal, Section } from '../components';
import type { Project, ProjectAddress, ProjectDependency, ProjectDetail, User } from '../models';
import { DeploymentHistory } from './ServerResources';

type Relation =
  { type: 'addresses'; item?: ProjectAddress } | { type: 'dependencies'; item?: ProjectDependency };

const labels = { addresses: '访问地址', dependencies: '项目依赖' };

export function ProjectRelations({
  project,
  user,
  reload,
}: {
  project: ProjectDetail;
  user: User;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Relation>();
  const [deleting, setDeleting] = useState<Relation>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = user.role !== 'VIEWER';

  async function deleteRelation() {
    if (!deleting?.item) return;
    setError('');
    setBusy(true);
    try {
      await remove(`/projects/${project.id}/${deleting.type}/${deleting.item.id}`);
      setDeleting(undefined);
      await reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function actions(relation: Relation) {
    return (
      canEdit && (
        <span className="row-actions">
          <button
            className="icon-button bare muted"
            aria-label={`编辑${labels[relation.type]}`}
            onClick={() => setEditing(relation)}
          >
            <Pencil size={15} />
          </button>
          <button
            className="icon-button bare muted"
            aria-label={`删除${labels[relation.type]}`}
            onClick={() => {
              setError('');
              setDeleting(relation);
            }}
          >
            <Trash2 size={15} />
          </button>
        </span>
      )
    );
  }

  return (
    <>
      <Section
        title="访问地址"
        action={
          canEdit && (
            <button
              className="button secondary small"
              onClick={() => setEditing({ type: 'addresses' })}
            >
              <Plus size={14} />
              添加地址
            </button>
          )
        }
      >
        {project.addresses?.length ? (
          <div className="resource-list">
            {project.addresses.map((item) => {
              const scope = [
                project.services.find(({ id }) => id === item.serviceId)?.name,
                project.environments.find(({ id }) => id === item.environmentId)?.name,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <div key={item.id}>
                  <span className="resource-avatar">
                    <Link2 size={17} />
                  </span>
                  <div>
                    <a href={item.url} className="text-link" target="_blank" rel="noreferrer">
                      {item.name}
                    </a>
                    <small title={item.url}>{item.url}</small>
                    {item.description && <small>{item.description}</small>}
                  </div>
                  <span className="tag">{scope || '项目级'}</span>
                  <span className="tag">{item.visibility === 'PUBLIC' ? '公开' : '内部'}</span>
                  {actions({ type: 'addresses', item })}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mini-empty">暂无访问地址</p>
        )}
      </Section>
      <Section
        title="项目依赖"
        action={
          canEdit && (
            <button
              className="button secondary small"
              onClick={() => setEditing({ type: 'dependencies' })}
            >
              <Plus size={14} />
              添加依赖
            </button>
          )
        }
      >
        {project.dependencies?.length ? (
          <div className="resource-list">
            {project.dependencies.map((item) => (
              <div key={item.id}>
                <span className="resource-avatar">
                  <Network size={17} />
                </span>
                <div>
                  <a href={`#/projects/${item.dependsOnProjectId}`} className="text-link">
                    {item.projectName}
                  </a>
                  {item.description && <small>{item.description}</small>}
                </div>
                <span className="tag">
                  {item.dependencyType === 'DEPLOYMENT' ? '部署依赖' : '运行依赖'}
                </span>
                {actions({ type: 'dependencies', item })}
              </div>
            ))}
          </div>
        ) : (
          <p className="mini-empty">暂无项目依赖</p>
        )}
      </Section>
      <Section
        title="项目部署概览"
        action={
          <a href="#/targets" className="text-link">
            部署目标管理
          </a>
        }
      >
        {!!project.pipelines?.length && (
          <div className="resource-list">
            {project.pipelines.map((pipeline) => (
              <div key={pipeline.id}>
                <span className="resource-avatar">
                  <Network size={17} />
                </span>
                <div>
                  <strong>{pipeline.name}</strong>
                  <small>
                    {project.services.find(({ id }) => id === pipeline.serviceId)?.name}
                  </small>
                </div>
                <span className="tag">Pipeline v{pipeline.version}</span>
                <span className="tag">{pipeline.enabled ? '已启用' : '已停用'}</span>
              </div>
            ))}
          </div>
        )}
        <div className="resource-list">
          {(project.deploymentTargets ?? []).map((target) => (
            <div key={target.id}>
              <span className="resource-avatar">
                <Network size={17} />
              </span>
              <div>
                <strong>{target.name}</strong>
                <small>{target.description}</small>
              </div>
              <span className="tag">{target.serverIds.length} 台</span>
            </div>
          ))}
        </div>
        <DeploymentHistory
          rows={project.recentDeployments ?? []}
          resolveName={(row) =>
            [
              project.services.find(({ id }) => id === row.serviceId)?.name,
              project.environments.find(({ id }) => id === row.environmentId)?.name,
            ]
              .filter(Boolean)
              .join(' · ')
          }
        />
      </Section>
      {editing && (
        <RelationEditor
          project={project}
          relation={editing}
          onClose={() => setEditing(undefined)}
          onSave={() => {
            setEditing(undefined);
            void reload();
          }}
        />
      )}
      {deleting?.item && (
        <Confirm
          title={`删除${labels[deleting.type]}`}
          description={`删除「${'name' in deleting.item ? deleting.item.name : deleting.item.projectName}」。`}
          onClose={() => !busy && setDeleting(undefined)}
          onConfirm={deleteRelation}
          busy={busy}
          error={error}
          destructive
          label="删除"
        />
      )}
    </>
  );
}

function RelationEditor({
  project,
  relation,
  onClose,
  onSave,
}: {
  project: ProjectDetail;
  relation: Relation;
  onClose: () => void;
  onSave: () => void;
}) {
  const address = relation.type === 'addresses' ? relation.item : undefined;
  const dependency = relation.type === 'dependencies' ? relation.item : undefined;
  const projects = useResource<Project[]>(relation.type === 'dependencies' ? '/projects' : null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const description = String(data.get('description')).trim();
    const body =
      relation.type === 'addresses'
        ? {
            description,
            name: String(data.get('name')).trim(),
            url: String(data.get('url')).trim(),
            serviceId: data.get('serviceId') || null,
            environmentId: data.get('environmentId') || null,
            addressType: data.get('addressType'),
            visibility: data.get('visibility'),
          }
        : {
            description,
            dependsOnProjectId: data.get('dependsOnProjectId'),
            dependencyType: data.get('dependencyType'),
          };
    setError('');
    setBusy(true);
    try {
      const path = `/projects/${project.id}/${relation.type}`;
      if (relation.item)
        await api(`${path}/${relation.item.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await post(path, body);
      onSave();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${relation.item ? '编辑' : '添加'}${labels[relation.type]}`}
      onClose={() => !busy && onClose()}
    >
      <Form onSubmit={save} error={error} busy={busy} onCancel={onClose}>
        {relation.type === 'addresses' ? (
          <>
            <Field label="名称" required>
              <input name="name" defaultValue={address?.name} required maxLength={100} autoFocus />
            </Field>
            <Field label="访问 URL" required>
              <input
                name="url"
                type="url"
                pattern="https?://.+"
                defaultValue={address?.url}
                required
                maxLength={2048}
              />
            </Field>
            <div className="form-grid">
              <Field label="关联服务">
                <select name="serviceId" defaultValue={address?.serviceId ?? ''}>
                  <option value="">所有服务</option>
                  {project.services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="关联环境">
                <select name="environmentId" defaultValue={address?.environmentId ?? ''}>
                  <option value="">所有环境</option>
                  {project.environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="类型">
                <select name="addressType" defaultValue={address?.addressType ?? 'WEB'}>
                  <option value="WEB">网页</option>
                  <option value="API">API</option>
                  <option value="DOCS">文档</option>
                </select>
              </Field>
              <Field label="可见范围">
                <select name="visibility" defaultValue={address?.visibility ?? 'INTERNAL'}>
                  <option value="INTERNAL">内部</option>
                  <option value="PUBLIC">公开</option>
                </select>
              </Field>
            </div>
          </>
        ) : (
          <>
            <ErrorBanner error={projects.error} retry={projects.reload} />
            <Field label="依赖项目" required>
              <select
                name="dependsOnProjectId"
                defaultValue={dependency?.dependsOnProjectId ?? ''}
                required
              >
                <option value="">选择项目</option>
                {projects.data
                  ?.filter(({ id }) => id !== project.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                {dependency &&
                  !projects.data?.some(({ id }) => id === dependency.dependsOnProjectId) && (
                    <option value={dependency.dependsOnProjectId}>{dependency.projectName}</option>
                  )}
              </select>
            </Field>
            <Field label="依赖类型">
              <select name="dependencyType" defaultValue={dependency?.dependencyType ?? 'RUNTIME'}>
                <option value="RUNTIME">运行依赖</option>
                <option value="DEPLOYMENT">部署依赖</option>
              </select>
            </Field>
          </>
        )}
        <Field label="说明">
          <textarea
            name="description"
            defaultValue={relation.item?.description}
            maxLength={2000}
            rows={2}
          />
        </Field>
      </Form>
    </Modal>
  );
}
