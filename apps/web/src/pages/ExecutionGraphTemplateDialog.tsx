import { useRef, useState, type FormEvent } from 'react';
import { message, post, useResource } from '../api';
import { ErrorBanner, Field, Loading, Modal } from '../components';
import type {
  GraphArtifactType,
  GraphCatalog,
  GraphFlowExpansion,
} from './execution-graph-definition';

const artifactNames: Record<GraphArtifactType, string> = {
  FILE: '文件',
  DIRECTORY: '目录',
  DOCKER_IMAGE: 'Docker 镜像',
};

export function ExecutionGraphTemplateDialog({
  path,
  insert,
  close,
}: {
  path: string;
  insert: (expansion: GraphFlowExpansion) => void;
  close: () => void;
}) {
  const catalog = useResource<GraphCatalog>(path + '/catalog');
  const templates = catalog.data?.flowTemplates ?? [];
  const [templateId, setTemplateId] = useState('');
  const [artifact, setArtifact] = useState<GraphArtifactType>('DIRECTORY');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const template = templates.find(({ id }) => id === templateId);

  async function expand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !template?.artifactTypes.includes(artifact)) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      insert(
        await post<GraphFlowExpansion>(path + '/draft/templates/expand', {
          templateId,
          artifactType: artifact,
        }),
      );
      close();
    } catch (err) {
      setError(message(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      title="插入流程模板"
      description="选择模板和主产物类型，作为一条新执行流加入草稿。"
      onClose={() => {
        if (!pending.current) close();
      }}
    >
      <form onSubmit={(event) => void expand(event)} aria-busy={busy}>
        <div className="form-body">
          <ErrorBanner error={catalog.error} retry={() => void catalog.reload()} />
          <ErrorBanner error={error} />
          {catalog.loading && <Loading />}
          {!catalog.loading && !catalog.error && !templates.length && (
            <p className="field-note">暂无可用的流程模板。</p>
          )}
          {!!templates.length && (
            <fieldset className="graph-template-options">
              <legend>流程模板</legend>
              {templates.map(({ id, name, steps, artifactTypes }) => (
                <label className="graph-field-card graph-template-choice" key={id}>
                  <input
                    type="radio"
                    name="graph-flow-template"
                    value={id}
                    checked={templateId === id}
                    disabled={busy}
                    onChange={() => {
                      setTemplateId(id);
                      if (!artifactTypes.includes(artifact))
                        setArtifact(
                          artifactTypes.includes('DIRECTORY') ? 'DIRECTORY' : artifactTypes[0]!,
                        );
                    }}
                  />
                  <span>
                    <strong>{name}</strong>
                    <small>{steps.join(' → ')}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {template && (
            <Field label="主产物类型">
              <select
                disabled={busy}
                value={artifact}
                onChange={(event) => setArtifact(event.target.value as GraphArtifactType)}
              >
                {template.artifactTypes.map((type) => (
                  <option key={type} value={type}>
                    {artifactNames[type]}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={!template || busy}>
            {busy ? '正在插入…' : '插入此流程'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
