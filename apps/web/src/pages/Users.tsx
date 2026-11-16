import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, Check, Plus, Users } from 'lucide-react';
import { api, message, post, useResource } from '../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Field,
  Form,
  Loading,
  Modal,
  PageHeader,
  RefreshButton,
  Section,
  Status,
} from '../components';
import { userRoleNames } from '../models';
import type { ManagedUser, User } from '../models';

type UserAction = { kind: 'create' } | { kind: 'role' | 'status' | 'password'; user: ManagedUser };

export function UsersPage({ user }: { user: User }) {
  return user.role === 'ADMIN' ? (
    <UserManagement currentUserId={user.id} />
  ) : (
    <>
      <PageHeader title="用户管理" description="仅管理员可以访问用户管理。" />
      <a className="button secondary" href="#/settings">
        <ArrowLeft size={16} /> 返回系统设置
      </a>
    </>
  );
}

function UserManagement({ currentUserId }: { currentUserId: string }) {
  const users = useResource<ManagedUser[]>('/users');
  const [action, setAction] = useState<UserAction>();
  const [notice, setNotice] = useState('');
  const newUserButton = (
    <button className="button primary" type="button" onClick={() => setAction({ kind: 'create' })}>
      <Plus size={16} /> 新建用户
    </button>
  );

  return (
    <>
      <PageHeader
        title="用户管理"
        description="管理工作空间账户、角色和登录状态。"
        action={
          <>
            <a className="button secondary" href="#/settings">
              <ArrowLeft size={16} /> 返回系统设置
            </a>
            {newUserButton}
          </>
        }
      />
      <ErrorBanner error={users.error} retry={users.reload} />
      {notice && (
        <p className="success-notice" role="status">
          <Check size={16} /> {notice}
        </p>
      )}
      <Section title="账户列表" action={<RefreshButton onClick={users.reload} />}>
        {users.loading ? (
          <Loading />
        ) : users.data?.length ? (
          <div className="table-scroll">
            <table className="user-management-table">
              <thead>
                <tr>
                  <th scope="col">用户名</th>
                  <th scope="col">角色</th>
                  <th scope="col">账户状态</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((account) => {
                  const self = account.id === currentUserId;
                  const enabled = account.status === 'ACTIVE';
                  return (
                    <tr key={account.id}>
                      <td>
                        <strong>{account.username}</strong>
                        {self && <small className="cell-sub">当前账号</small>}
                      </td>
                      <td>{userRoleNames[account.role]}</td>
                      <td>
                        <Status value={account.status} />
                        {account.mustChangePassword && (
                          <small className="cell-sub">登录时需改密</small>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          {self ? (
                            <a className="text-link" href="#/account/password">
                              修改密码
                            </a>
                          ) : (
                            <>
                              <button
                                className="text-button"
                                type="button"
                                onClick={() => setAction({ kind: 'role', user: account })}
                              >
                                编辑角色
                              </button>
                              <button
                                className="text-button"
                                type="button"
                                onClick={() => setAction({ kind: 'status', user: account })}
                              >
                                {enabled ? '停用' : '启用'}
                              </button>
                              <button
                                className="text-button"
                                type="button"
                                onClick={() => setAction({ kind: 'password', user: account })}
                              >
                                重置密码
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          !users.error && (
            <Empty icon={<Users size={23} />} title="暂无用户" description="新建账户以授权访问。" />
          )
        )}
      </Section>
      {action && (
        <UserActionDialog
          action={action}
          onClose={() => setAction(undefined)}
          onSaved={(success) => {
            setAction(undefined);
            setNotice(success);
            void users.reload();
          }}
        />
      )}
    </>
  );
}

function UserActionDialog({
  action,
  onClose,
  onSaved,
}: {
  action: UserAction;
  onClose: () => void;
  onSaved: (notice: string) => void;
}) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const account = 'user' in action ? action.user : undefined;
  const path = account ? `/users/${account.id}` : '/users';
  const close = () => {
    if (!saving) onClose();
  };

  async function save(request: () => Promise<ManagedUser>, success: (user: ManagedUser) => string) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      onSaved(success(await request()));
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }

  function update(fields: Partial<Pick<ManagedUser, 'role' | 'status'>>) {
    return api<ManagedUser>(path, { method: 'PATCH', body: JSON.stringify(fields) });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (action.kind === 'role') {
      const role = fields.get('role') as User['role'];
      if (role === action.user.role) {
        onClose();
        return;
      }
      void save(
        () => update({ role }),
        (user) => `已将 ${user.username} 的角色设为${userRoleNames[user.role]}。`,
      );
      return;
    }
    const password = String(fields.get('password'));
    if (password !== fields.get('confirmation')) {
      setError('两次输入的临时密码不一致。');
      event.currentTarget.querySelector<HTMLInputElement>('[name="confirmation"]')?.focus();
      return;
    }
    if (action.kind === 'create') {
      void save(
        () =>
          post<ManagedUser>(path, {
            username: fields.get('username'),
            role: fields.get('role'),
            password,
          }),
        (user) => `已创建用户 ${user.username}，首次登录时需要修改密码。`,
      );
    } else {
      void save(
        () => post<ManagedUser>(path + '/reset-password', { password }),
        (user) => `已重置 ${user.username} 的密码，下次登录时需要修改密码。`,
      );
    }
  }

  if (action.kind === 'status') {
    const enabled = action.user.status === 'ACTIVE';
    const label = enabled ? '停用' : '启用';
    return (
      <Confirm
        title={label + '用户'}
        description={
          enabled
            ? `停用 ${action.user.username} 后，现有会话立即失效，账户无法登录。`
            : `启用 ${action.user.username} 后，用户可以使用当前密码重新登录。`
        }
        busy={saving}
        error={error}
        onClose={close}
        onConfirm={() =>
          void save(
            () => update({ status: enabled ? 'DISABLED' : 'ACTIVE' }),
            (user) => `已${label}用户 ${user.username}。`,
          )
        }
        label={'确认' + label}
        destructive={enabled}
      />
    );
  }

  const creating = action.kind === 'create';
  const editingRole = action.kind === 'role';
  return (
    <Modal
      title={creating ? '新建用户' : editingRole ? '编辑角色' : '重置密码'}
      description={
        creating
          ? '用户首次登录时需要修改临时密码。'
          : editingRole
            ? `更新 ${action.user.username} 的角色后，该用户需要重新登录。`
            : `重置 ${action.user.username} 的密码会使现有会话失效。用户下次登录时需要修改临时密码。`
      }
      onClose={close}
    >
      <Form
        onSubmit={submit}
        onCancel={close}
        busy={saving}
        error={error}
        submit={creating ? '创建用户' : editingRole ? '保存角色' : '确认重置'}
      >
        {creating && (
          <Field
            label="用户名"
            hint="使用 2–64 个字母、数字、点、下划线或短横线，以字母或数字开头。"
          >
            <input
              name="username"
              autoComplete="off"
              autoFocus
              minLength={2}
              maxLength={64}
              pattern={'[a-zA-Z0-9][a-zA-Z0-9._\\-]{1,63}'}
              required
            />
          </Field>
        )}
        {(creating || editingRole) && (
          <Field label="角色">
            <select name="role" defaultValue={editingRole ? action.user.role : 'VIEWER'}>
              {Object.entries(userRoleNames).map(([role, label]) => (
                <option value={role} key={role}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!editingRole && (
          <>
            <Field label="临时密码" hint="至少 12 个字符。">
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                autoFocus={!creating}
                minLength={12}
                maxLength={256}
                required
              />
            </Field>
            <Field label="确认临时密码">
              <input
                name="confirmation"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                required
              />
            </Field>
          </>
        )}
      </Form>
    </Modal>
  );
}
