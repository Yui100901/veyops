import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { message, post } from '../../api';
import { ErrorBanner, Section } from '../../components';
import type { User } from '../../models';
import { AIPage } from '../ai/AI';
import type { TargetPreview, TargetSelection } from './BatchTargets';

export function TargetedOperationsAI({
  user,
  selection,
  projectId,
  disabled,
}: {
  user: User;
  selection: TargetSelection;
  projectId?: string;
  disabled: boolean;
}) {
  const [targets, setTargets] = useState<TargetPreview['targets']>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    setBusy(true);
    setError('');
    try {
      setTargets((await post<TargetPreview>('/commands/preview', selection)).targets);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  if (!targets)
    return (
      <div className="workbench-stack">
        <div>
          <button
            className="button secondary"
            type="button"
            disabled={disabled || busy}
            onClick={() => void open()}
          >
            <Sparkles size={16} /> {busy ? '正在解析目标…' : 'AI 运维助手'}
          </button>
        </div>
        <ErrorBanner error={error} />
      </div>
    );
  return (
    <Section
      title="AI 运维助手"
      subtitle={`本对话绑定 ${targets.length} 台服务器 · ${targets.map(({ name }) => name).join('、')}`}
      action={
        <button
          className="button secondary small"
          type="button"
          onClick={() => setTargets(undefined)}
        >
          <X size={14} /> 关闭助手
        </button>
      }
    >
      <AIPage
        user={user}
        scopedProjectId={projectId}
        context={{ kind: 'COMMAND_TARGETS', serverIds: targets.map(({ id }) => id) }}
      />
    </Section>
  );
}
