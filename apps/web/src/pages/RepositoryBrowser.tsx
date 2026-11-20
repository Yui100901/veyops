import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Check,
  CircleCheck,
  Copy,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  Wifi,
} from 'lucide-react';
import { api, message, post, useResource } from '../api';
import { Empty, ErrorBanner, Field, Loading } from '../components';
import { InlineEditor } from '../InlineEditor';
import type { Environment, Repository, Service, User } from '../models';
import { ContextAIButton } from './AI';
import {
  projectGraphPath,
  projectResourcePath,
  type GraphResourceReturn,
} from './project-workspace-route';

import { BranchSyncControls, useRepositoryBranches } from './RepositoryBranches';
export interface RepositoryCommit {
  sha: string;
  subject: string;
  authoredAt: string;
  authorName: string;
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
function commitDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : dateFormat.format(date);
}

function repositoryPath(projectId: string, repositoryId: string) {
  return `/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}`;
}

export function RepositoryBrowser({
  projectId,
  repository,
  onSelect,
  selectedSha,
  onSynced,
}: {
  projectId: string;
  repository: Repository;
  onSelect?: (commit: RepositoryCommit, branch: string) => void;
  selectedSha?: string;
  onSynced?: () => void;
}) {
  const path = repositoryPath(projectId, repository.id);
  const branches = useRepositoryBranches(path, onSynced);
  const [chosenBranch, setChosenBranch] = useState('');
  const names = branches.data?.branches ?? [];
  const branch =
    names.find((item) => item.name === chosenBranch)?.name ||
    names.find((item) => item.name === branches.data?.defaultBranch)?.name ||
    names.find((item) => item.name === repository.defaultBranch)?.name ||
    names[0]?.name;

  if (branches.loading) return <Loading />;
  return (
    <div className="repository-browser">
      <BranchSyncControls branches={branches} />
      {branches.data?.syncedAt && !names.length && (
        <Empty
          icon={<GitBranch size={25} />}
          title="仓库暂无分支"
          description="推送首次提交后，刷新分支列表即可查看。"
        />
      )}
      {branch && (
        <>
          <div className="repository-browser-controls">
            <Field label="分支">
              <select value={branch} onChange={(event) => setChosenBranch(event.target.value)}>
                {names.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                    {item.name === branches.data?.defaultBranch ? '（默认）' : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <RepositoryCommits
            key={`${branch}:${names.find((item) => item.name === branch)?.sha}`}
            path={path}
            branch={branch}
            onSelect={onSelect}
            selectedSha={selectedSha}
          />
        </>
      )}
    </div>
  );
}

function RepositoryCommits({
  path,
  branch,
  onSelect,
  selectedSha,
}: {
  path: string;
  branch: string;
  onSelect?: (commit: RepositoryCommit, branch: string) => void;
  selectedSha?: string;
}) {
  const commits = useResource<{ commits: RepositoryCommit[] }>(
    `${path}/commits?branch=${encodeURIComponent(branch)}&limit=20`,
  );
  const [notice, setNotice] = useState('');
  async function copy(sha: string) {
    try {
      await navigator.clipboard.writeText(sha);
      setNotice(`已复制 ${sha.slice(0, 12)} 的完整 SHA。`);
    } catch {
      setNotice('请选中文本并手动复制完整 SHA。');
    }
  }
  return (
    <>
      <div className="repository-commits-heading">
        <strong>最近提交</strong>
        <button className="text-button" type="button" onClick={() => void commits.reload()}>
          <RefreshCw size={13} />
          刷新提交
        </button>
      </div>
      <ErrorBanner error={commits.error} retry={commits.reload} />
      {commits.loading ? (
        <Loading />
      ) : !commits.error && !commits.data?.commits.length ? (
        <p className="field-note">这个分支暂无可查看的提交。</p>
      ) : (
        <ul className="repository-commit-list">
          {commits.data?.commits.map((commit) => (
            <li key={commit.sha}>
              <GitCommitHorizontal size={17} />
              <div className="repository-commit-detail">
                <strong title={commit.subject}>{commit.subject || '无提交说明'}</strong>
                <code>{commit.sha}</code>
                <small>
                  {[commit.authorName, commitDate(commit.authoredAt)].filter(Boolean).join(' · ')}
                </small>
              </div>
              {onSelect ? (
                <button
                  className="button secondary small"
                  type="button"
                  aria-label={`选择提交 ${commit.sha.slice(0, 12)}`}
                  aria-pressed={selectedSha === commit.sha}
                  onClick={() => onSelect(commit, branch)}
                >
                  {selectedSha === commit.sha ? (
                    <>
                      <Check size={14} />
                      已选
                    </>
                  ) : (
                    '选择'
                  )}
                </button>
              ) : (
                <button
                  className="button secondary icon-button"
                  type="button"
                  title="复制完整 SHA"
                  aria-label={`复制提交 ${commit.sha.slice(0, 12)} 的完整 SHA`}
                  onClick={() => void copy(commit.sha)}
                >
                  <Copy size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p className="field-note" role="status">
          {notice}
        </p>
      )}
    </>
  );
}

export function RepositoryDetails({
  user,
  projectId,
  repository,
  services,
  environments,
  onClose,
  onSynced,
  view,
  panel,
  actions,
  graphBack,
}: {
  projectId: string;
  repository: Repository;
  services: Service[];
  environments: Environment[];
  user: User;
  onClose: () => void;
  onSynced?: () => void;
  view?: string;
  panel?: string;
  actions?: ReactNode;
  graphBack?: GraphResourceReturn;
}) {
  const [checking, setChecking] = useState(false);
  const [connection, setConnection] = useState<{ ok: true; defaultBranch: string | null }>();
  const [error, setError] = useState('');
  const canInspect = user.role !== 'VIEWER';
  const pane = (next: string) =>
    '#' +
    projectResourcePath(projectId, {
      ...graphBack,
      resource: 'repositories',
      repositoryId: repository.id,
      view,
      panel: next === panel ? undefined : next,
    });
  async function checkConnection() {
    setChecking(true);
    setError('');
    setConnection(undefined);
    try {
      const result = await api<{ ok: true; defaultBranch: string | null }>(
        `${repositoryPath(projectId, repository.id)}/connection`,
      );
      setConnection(result);
    } catch (err) {
      setError(message(err));
    } finally {
      setChecking(false);
    }
  }
  return (
    <InlineEditor title={repository.name} onClose={onClose} wide>
      <div className="form-body">
        <p className="repository-url mono">{repository.cloneUrl}</p>
        <details className="advanced-options">
          <summary>仓库 ID</summary>
          <code>{repository.id}</code>
        </details>
        <div className="repository-detail-actions">
          {actions}
          {canInspect && (
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => void checkConnection()}
                disabled={checking}
              >
                <Wifi size={16} />
                {checking ? '正在测试…' : '测试连接'}
              </button>
              <a
                className="button primary"
                href={pane('commits')}
                aria-current={panel === 'commits' ? 'page' : undefined}
              >
                <GitBranch size={16} />
                浏览分支与提交
              </a>
              <a
                className="button secondary"
                href={pane('analysis')}
                aria-current={panel === 'analysis' ? 'page' : undefined}
              >
                <FileCode2 size={16} />
                AI 分析仓库
              </a>
            </>
          )}
          <a className="text-link" href={'#' + projectGraphPath(projectId, { view })}>
            打开项目执行图 →
          </a>
          <ContextAIButton
            user={user}
            projectId={projectId}
            context={{ kind: 'REPOSITORY', repositoryId: repository.id }}
            objectName={repository.name}
            label="询问 AI"
          />
        </div>
        <ErrorBanner error={error} />
        {connection && (
          <p className="success-notice" role="status">
            <CircleCheck size={16} />
            连接成功
            {connection.defaultBranch ? `，远程默认分支为 ${connection.defaultBranch}。` : '。'}
          </p>
        )}
        {canInspect && panel === 'commits' && (
          <RepositoryBrowser projectId={projectId} repository={repository} onSynced={onSynced} />
        )}
        {canInspect && panel === 'analysis' && (
          <RepositoryAnalysis
            user={user}
            projectId={projectId}
            repository={repository}
            services={services}
            environments={environments}
          />
        )}
      </div>
    </InlineEditor>
  );
}

interface RepositoryAnalysisResult {
  source: { path: string; commitSha: string };
  draft: { name: string; projectId: string; serviceId?: string; definition: object };
  environmentId?: string;
  notes: string[];
  missingFields?: string[];
  evidencePaths?: string[];
  technologies?: string[];
  detectedServices?: { name: string; path: string; technology?: string }[];
}

function RepositoryAnalysis({
  user,
  projectId,
  repository,
  services,
  environments,
}: {
  user: User;
  projectId: string;
  repository: Repository;
  services: Service[];
  environments: Environment[];
}) {
  const [commit, setCommit] = useState<RepositoryCommit>();
  const [selectedService, setSelectedService] = useState('');
  const [choosingCommit, setChoosingCommit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RepositoryAnalysisResult>();
  const [copyStatus, setCopyStatus] = useState('');

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const docPath = String(fields.get('docPath') ?? '').trim();
    const repoPath = String(fields.get('repoPath') ?? '').trim();
    const environmentId = fields.get('environmentId');
    const serviceId = fields.get('serviceId');
    setBusy(true);
    setError('');
    setResult(undefined);
    setCopyStatus('');
    try {
      const analysis = await post<RepositoryAnalysisResult>('/ai/repository-analysis', {
        projectId,
        repositoryId: repository.id,
        ...(commit ? { commitSha: commit.sha } : {}),
        ...(environmentId ? { environmentId } : {}),
        ...(serviceId ? { serviceId } : {}),
        ...(docPath ? { docPath } : {}),
        ...(repoPath ? { repoPath } : {}),
      });
      setResult(analysis);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyDraft(draft: RepositoryAnalysisResult['draft']) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
      setCopyStatus('已复制草稿。');
    } catch {
      setCopyStatus('复制失败，请从预览中手动复制。');
    }
  }

  const draftJson = result ? JSON.stringify(result.draft, null, 2) : '';
  return (
    <div className="repository-browser">
      <p className="field-note">
        可直接分析仓库默认分支，也可以指定提交和构建子目录。可参考生成的配置设置执行流。
      </p>
      <div className="repository-detail-actions">
        <button
          className="button secondary small"
          type="button"
          disabled={busy}
          aria-expanded={choosingCommit}
          onClick={() => setChoosingCommit((open) => !open)}
        >
          <GitBranch size={15} />
          {choosingCommit ? '收起提交列表' : '选择提交'}
        </button>
        {(commit || selectedService) && (
          <ContextAIButton
            user={user}
            projectId={projectId}
            context={{
              kind: 'REPOSITORY',
              repositoryId: repository.id,
              commitSha: commit?.sha,
              serviceId: selectedService || undefined,
            }}
            objectName={[
              repository.name,
              services.find((service) => service.id === selectedService)?.name,
            ]
              .filter(Boolean)
              .join(' · ')}
            label={commit ? `询问 AI · ${commit.sha.slice(0, 8)}` : '询问此服务的仓库配置'}
          />
        )}
        {commit && (
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setCommit(undefined);
              setResult(undefined);
              setError('');
              setCopyStatus('');
            }}
          >
            改用默认分支
          </button>
        )}
      </div>
      {choosingCommit && (
        <RepositoryBrowser
          projectId={projectId}
          repository={repository}
          selectedSha={commit?.sha}
          onSelect={(selected) => {
            if (busy) return;
            setCommit(selected);
            setChoosingCommit(false);
            setResult(undefined);
            setError('');
            setCopyStatus('');
          }}
        />
      )}
      <form
        onSubmit={analyze}
        onChange={() => {
          setResult(undefined);
          setCopyStatus('');
        }}
      >
        <fieldset className="form-grid" disabled={busy}>
          <Field label="服务" hint="可在采用草稿后关联服务。">
            <select
              name="serviceId"
              value={selectedService}
              onChange={(event) => setSelectedService(event.target.value)}
            >
              <option value="">自动选择</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="运行环境" hint="按环境区分构建方式时可手动选择。">
            <select name="environmentId">
              <option value="">自动选择</option>
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="仓库子目录" hint="仅分析指定子目录时填写。">
            <input name="repoPath" placeholder="例如 apps/api" maxLength={240} />
          </Field>
          <Field label="部署说明路径" hint="相对于仓库根目录，留空自动查找。">
            <input name="docPath" placeholder="DEPLOY.md" maxLength={240} />
          </Field>
        </fieldset>
        <div className="inline-form-footer">
          {commit && (
            <span className="field-note">
              已选提交 <code>{commit.sha.slice(0, 12)}</code>
            </span>
          )}
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? '正在分析…' : '生成构建与部署建议'}
          </button>
        </div>
      </form>
      <ErrorBanner error={error} />
      {result && (
        <div className="ai-draft-card">
          <div>
            <FileCode2 size={18} />
            <strong>{result.draft.name}</strong>
          </div>
          <p className="field-note">
            固定提交 <code>{result.source.commitSha}</code>
          </p>
          {!!result.technologies?.length && (
            <p className="field-note">技术栈 {result.technologies.join('、')}</p>
          )}
          {!!result.detectedServices?.length && (
            <details>
              <summary>识别到的服务</summary>
              <ul>
                {result.detectedServices.map((service, index) => (
                  <li key={index}>
                    {service.name} · <code>{service.path}</code>
                    {service.technology ? ` · ${service.technology}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details>
            <summary>分析依据</summary>
            <ul>
              {(result.evidencePaths?.length ? result.evidencePaths : [result.source.path]).map(
                (path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ),
              )}
            </ul>
          </details>
          {!!result.notes.length && (
            <ul>
              {result.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
          {!!result.missingFields?.length && (
            <p className="field-note">待审核补充 {result.missingFields.join('、')}</p>
          )}
          <details open>
            <summary>配置建议 JSON</summary>
            <pre className="code-preview">{draftJson}</pre>
          </details>
          <div className="repository-detail-actions">
            <button
              className="button secondary small"
              type="button"
              onClick={() => void copyDraft(result.draft)}
            >
              <Copy size={14} />
              复制草稿
            </button>
            <button
              className="button secondary small"
              type="button"
              onClick={() => {
                setResult(undefined);
                setCopyStatus('');
              }}
            >
              放弃草稿
            </button>
          </div>
          {copyStatus && (
            <p className="field-note" role="status">
              {copyStatus}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
