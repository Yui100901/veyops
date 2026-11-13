import { useState, type FormEvent } from 'react';
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
import { Empty, ErrorBanner, Field, Loading, Modal } from '../components';
import type { Environment, Repository, Service } from '../models';

interface RepositoryBranch {
  name: string;
  sha: string;
}
interface RepositoryBranches {
  defaultBranch: string | null;
  branches: RepositoryBranch[];
}
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
}: {
  projectId: string;
  repository: Repository;
  onSelect?: (commit: RepositoryCommit, branch: string) => void;
  selectedSha?: string;
}) {
  const path = repositoryPath(projectId, repository.id);
  const branches = useResource<RepositoryBranches>(`${path}/branches`);
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
      <ErrorBanner error={branches.error} retry={branches.reload} />
      {!branches.error && !names.length && (
        <Empty
          icon={<GitBranch size={25} />}
          title="仓库暂无分支"
          description="推送首次提交后，刷新分支列表即可查看。"
          action={
            <button
              className="button secondary small"
              type="button"
              onClick={() => void branches.reload()}
            >
              <RefreshCw size={14} />
              刷新分支
            </button>
          }
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
            <button
              className="button secondary icon-button"
              type="button"
              title="刷新分支"
              aria-label="刷新分支"
              onClick={() => void branches.reload()}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <RepositoryCommits
            key={branch}
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
  projectId,
  repository,
  services,
  environments,
  onClose,
}: {
  projectId: string;
  repository: Repository;
  services: Service[];
  environments: Environment[];
  onClose: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [connection, setConnection] = useState<{ ok: true; defaultBranch: string | null }>();
  const [error, setError] = useState('');
  const [section, setSection] = useState<'commits' | 'analysis'>();
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
    <Modal
      title={repository.name}
      description="检查 Git 连接、浏览提交，或根据部署说明生成 Pipeline 草稿。"
      onClose={onClose}
      wide
    >
      <div className="form-body">
        <p className="repository-url mono">{repository.cloneUrl}</p>
        <div className="repository-detail-actions">
          <button
            className="button secondary"
            type="button"
            onClick={() => void checkConnection()}
            disabled={checking}
          >
            <Wifi size={16} />
            {checking ? '正在测试…' : '测试连接'}
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setSection(section === 'commits' ? undefined : 'commits')}
            aria-expanded={section === 'commits'}
          >
            <GitBranch size={16} />
            浏览分支与提交
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => setSection(section === 'analysis' ? undefined : 'analysis')}
            aria-expanded={section === 'analysis'}
          >
            <FileCode2 size={16} />
            分析部署说明
          </button>
          <a
            className="text-link"
            href={`#/pipelines?${new URLSearchParams({ projectId, repositoryId: repository.id })}`}
          >
            查看此仓库的 Pipeline →
          </a>
        </div>
        <ErrorBanner error={error} />
        {connection && (
          <p className="success-notice" role="status">
            <CircleCheck size={16} />
            连接成功
            {connection.defaultBranch ? `，远程默认分支为 ${connection.defaultBranch}。` : '。'}
          </p>
        )}
        {section === 'commits' && (
          <RepositoryBrowser projectId={projectId} repository={repository} />
        )}
        {section === 'analysis' && (
          <RepositoryAnalysis
            projectId={projectId}
            repository={repository}
            services={services}
            environments={environments}
          />
        )}
      </div>
    </Modal>
  );
}

interface RepositoryAnalysisResult {
  source: { path: string; commitSha: string };
  draft: { name: string; projectId: string; serviceId: string; definition: object };
  environmentId: string;
  notes: string[];
}

function RepositoryAnalysis({
  projectId,
  repository,
  services,
  environments,
}: {
  projectId: string;
  repository: Repository;
  services: Service[];
  environments: Environment[];
}) {
  const [commit, setCommit] = useState<RepositoryCommit>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RepositoryAnalysisResult>();
  const [copyStatus, setCopyStatus] = useState('');

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!commit || busy) return;
    const fields = new FormData(event.currentTarget);
    const docPath = String(fields.get('docPath') ?? '').trim();
    setBusy(true);
    setError('');
    setResult(undefined);
    setCopyStatus('');
    try {
      const analysis = await post<RepositoryAnalysisResult>('/ai/repository-analysis', {
        projectId,
        repositoryId: repository.id,
        commitSha: commit.sha,
        environmentId: fields.get('environmentId'),
        serviceId: fields.get('serviceId'),
        ...(docPath ? { docPath } : {}),
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

  if (!services.length || !environments.length) {
    return <p className="field-note">请先在项目中添加服务和运行环境，再分析部署说明。</p>;
  }

  const draftJson = result ? JSON.stringify(result.draft, null, 2) : '';
  return (
    <div className="repository-browser">
      <p className="field-note">选择提交并读取该版本中的部署说明，生成供审阅的 Pipeline 草稿。</p>
      <RepositoryBrowser
        projectId={projectId}
        repository={repository}
        selectedSha={commit?.sha}
        onSelect={(selected) => {
          if (busy) return;
          setCommit(selected);
          setResult(undefined);
          setError('');
          setCopyStatus('');
        }}
      />
      <form
        onSubmit={analyze}
        onChange={() => {
          setResult(undefined);
          setCopyStatus('');
        }}
      >
        <fieldset className="form-grid" disabled={busy}>
          <Field label="服务" required>
            <select name="serviceId" required>
              <option value="">选择服务</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="运行环境" required>
            <select name="environmentId" required>
              <option value="">选择环境</option>
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="部署说明路径" hint="相对于仓库根目录。留空使用 DEPLOY.md。">
            <input name="docPath" placeholder="DEPLOY.md" maxLength={240} />
          </Field>
        </fieldset>
        <div className="inline-form-footer">
          {commit && (
            <span className="field-note">
              已选提交 <code>{commit.sha.slice(0, 12)}</code>
            </span>
          )}
          <button className="button primary" type="submit" disabled={!commit || busy}>
            {busy ? '正在分析…' : '生成 Pipeline 草稿'}
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
            来源 <code>{result.source.path}</code> · <code>{result.source.commitSha}</code>
          </p>
          {!!result.notes.length && (
            <ul>
              {result.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
          <details open>
            <summary>Pipeline 草稿 JSON</summary>
            <pre className="code-preview">{draftJson}</pre>
          </details>
          <button
            className="button secondary small"
            type="button"
            onClick={() => void copyDraft(result.draft)}
          >
            <Copy size={14} />
            复制草稿
          </button>
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
