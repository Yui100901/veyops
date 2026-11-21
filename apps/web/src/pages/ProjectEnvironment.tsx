import { useState, type FormEvent, type ReactNode } from 'react';
import { api, message } from '../api';
import { Field, Form, Section } from '../components';
import type { Environment, ProjectDetail, User } from '../models';
import {
  DeploymentSelectionPicker,
  deploymentSelection,
  hasDeploymentSelection,
  useDeploymentInventory,
} from './DeploymentSelection';
import { EnvironmentVariables } from './EnvironmentVariables';
import { projectResourcePath, type GraphResourceReturn } from './project-workspace-route';

const panels = { file: '环境文件', variables: '环境变量', targets: '默认发布目标' };

export function ProjectEnvironment({
  project,
  environment,
  user,
  view,
  panel,
  reload,
  actions,
  graphBack,
}: {
  project: ProjectDetail;
  environment: Environment;
  user: User;
  view?: string;
  panel?: string;
  reload: () => Promise<void>;
  actions: ReactNode;
  graphBack: GraphResourceReturn;
}) {
  const active = panel === 'variables' || panel === 'targets' ? panel : 'file';
  const path = (tab?: string) =>
    '#' +
    projectResourcePath(project.id, {
      ...graphBack,
      view,
      resource: 'environments',
      environmentId: environment.id,
      panel: tab,
    });
  return (
    <>
      <Section
        title={environment.name}
        subtitle={environment.description || environment.slug}
        action={actions}
        className="project-service-detail"
      >
        <nav className="resource-section-switcher" aria-label="环境详情">
          {Object.entries(panels).map(([key, label]) => (
            <a key={key} href={path(key)} aria-current={active === key ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
      </Section>
      {active === 'variables' ? (
        <Section title="环境变量" subtitle="同名变量覆盖项目公共变量。">
          <EnvironmentVariables projectId={project.id} environmentId={environment.id} user={user} />
        </Section>
      ) : (
        <EnvironmentSettings
          key={environment.id}
          projectId={project.id}
          environment={environment}
          user={user}
          reload={reload}
          targets={active === 'targets'}
        />
      )}
    </>
  );
}

function EnvironmentSettings({
  projectId,
  environment,
  user,
  reload,
  targets,
}: {
  projectId: string;
  environment: Environment;
  user: User;
  reload: () => Promise<void>;
  targets: boolean;
}) {
  const inventory = useDeploymentInventory(targets);
  const [selection, setSelection] = useState(() =>
    deploymentSelection(environment.defaultTargetSelection),
  );
  const [envFile, setEnvFile] = useState(environment.repositoryEnvFile || '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(false);
  const [error, setError] = useState('');
  const readOnly = user.role === 'VIEWER';
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly || busy) return;
    setBusy(true);
    setNotice(false);
    setError('');
    try {
      const saved = await api<Environment>(
        `/projects/${projectId}/environments/${environment.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            ...(targets
              ? { defaultTargetSelection: hasDeploymentSelection(selection) ? selection : null }
              : { repositoryEnvFile: envFile.trim() || null }),
          }),
        },
      );
      setEnvFile(saved.repositoryEnvFile || '');
      setSelection(deploymentSelection(saved.defaultTargetSelection));
      setNotice(true);
      await reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title={targets ? '环境默认发布目标' : '仓库环境文件'}
      subtitle={
        targets ? '发布流程未指定目标且服务未设置覆盖时，使用这里选择的服务器或分组。' : undefined
      }
    >
      <Form
        onSubmit={save}
        busy={busy}
        submitDisabled={
          readOnly || (targets && (inventory.servers.loading || inventory.groups.loading))
        }
        submit={readOnly ? '只读用户' : targets ? '保存默认发布目标' : '保存环境文件'}
        error={error}
      >
        {targets ? (
          <DeploymentSelectionPicker
            projectId={projectId}
            inventory={inventory}
            value={selection}
            onChange={(value) => {
              setSelection(value);
              setNotice(false);
            }}
            disabled={readOnly || busy}
          />
        ) : (
          <Field label="仓库环境文件" hint="填写仓库工作区的相对路径。留空时按环境标识查找。">
            <input
              value={envFile}
              disabled={readOnly || busy}
              maxLength={300}
              placeholder=".env.test"
              onChange={(event) => {
                setEnvFile(event.target.value);
                setNotice(false);
              }}
            />
          </Field>
        )}
        {notice && (
          <p className="success-notice" role="status">
            {targets ? '默认发布目标已保存。' : '环境文件路径已保存。'}
          </p>
        )}
      </Form>
    </Section>
  );
}
