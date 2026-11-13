import { useEffect, useId, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, Check, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';

export function ErrorBanner({ error, retry }: { error?: string; retry?: () => void }) {
  return error ? (
    <div className="error-banner" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          重试
        </button>
      )}
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={21} className="spin" />
      <span>正在加载工作空间…</span>
    </div>
  );
}
export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon ?? <Plus size={23} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="heading-actions">{action}</div>}
    </div>
  );
}
export function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="button secondary icon-button"
      onClick={onClick}
      aria-label="刷新数据"
      title="刷新数据"
    >
      <RefreshCw size={16} />
    </button>
  );
}

const statusNames: Record<string, string> = {
  PENDING: '等待执行',
  RUNNING: '执行中',
  SUCCESS: '成功',
  FAILED: '失败',
  PARTIAL_FAILED: '部分失败',
  CANCEL_REQUESTED: '正在取消',
  CANCELLED: '已取消',
  TIMED_OUT: '已超时',
  NEEDS_ATTENTION: '需要检查',
  ONLINE: '连接正常',
  OFFLINE: '连接失败',
  UNKNOWN: '未检测',
  ACTIVE: '已启用',
  DISABLED: '已禁用',
  SKIPPED: '已跳过',
};
export function Status({ value }: { value: string }) {
  const tone = ['SUCCESS', 'ONLINE', 'ACTIVE'].includes(value)
    ? 'green'
    : ['FAILED', 'OFFLINE', 'TIMED_OUT', 'PARTIAL_FAILED'].includes(value)
      ? 'red'
      : ['RUNNING', 'PENDING', 'CANCEL_REQUESTED', 'NEEDS_ATTENTION'].includes(value)
        ? 'amber'
        : 'gray';
  return (
    <span className={`status ${tone}`}>
      <span />
      {statusNames[value] ?? value}
    </span>
  );
}

export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <button className="icon-button bare" type="button" onClick={onClose} aria-label="关闭">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  hint,
  children,
  required = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required && <span className="required"> *</span>}
      </span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Form({
  onSubmit,
  children,
  busy,
  submit = '保存',
  onCancel,
  error,
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  busy?: boolean;
  submit?: string;
  onCancel: () => void;
  error?: string;
}) {
  return (
    <form onSubmit={onSubmit}>
      <div className="form-body">
        {children}
        <ErrorBanner error={error} />
      </div>
      <div className="modal-footer">
        <button className="button secondary" type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
          {busy ? '正在处理…' : submit}
        </button>
      </div>
    </form>
  );
}
export function Confirm({
  title,
  description,
  detail,
  onClose,
  onConfirm,
  busy,
  error,
  destructive = false,
  label = '确认',
}: {
  title: string;
  description: string;
  detail?: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  busy?: boolean;
  error?: string;
  destructive?: boolean;
  label?: string;
}) {
  return (
    <Modal title={title} description={description} onClose={onClose}>
      <div className="form-body">
        {detail}
        <ErrorBanner error={error} />
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className={`button ${destructive ? 'danger' : 'primary'}`}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy && <LoaderCircle size={16} className="spin" />}
          {label}
        </button>
      </div>
    </Modal>
  );
}
export function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="text-link" href={`#${href}`}>
      {children}
      <ArrowUpRight size={14} />
    </a>
  );
}
export function Section({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
