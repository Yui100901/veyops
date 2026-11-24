import { FileClock } from 'lucide-react';
import { formatTime, useResource } from '../../api';
import { Empty, ErrorBanner, Loading, PageHeader, RefreshButton, Section } from '../../components';
import type { Audit } from '../../models';

export function AuditPage() {
  const resource = useResource<Audit[]>('/audit');
  return (
    <>
      <PageHeader
        eyebrow="TRACEABILITY"
        title="操作审计"
        description="记录资源变更和执行行为，让关键操作可以追溯。"
        action={<RefreshButton onClick={resource.reload} />}
      />
      <ErrorBanner error={resource.error} retry={resource.reload} />
      <Section title="审计记录" subtitle="按最近操作时间排序">
        {resource.loading ? (
          <Loading />
        ) : !resource.data?.length ? (
          <Empty
            icon={<FileClock size={25} />}
            title="暂无审计记录"
            description="资源创建、变更与命令执行等操作会记录在这里。"
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>操作</th>
                  <th>资源类型</th>
                  <th>资源标识</th>
                  <th>操作者</th>
                  <th>发生时间</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="table-name">
                        <span className="tiny-icon">
                          <FileClock size={15} />
                        </span>
                        {item.action}
                      </span>
                    </td>
                    <td>
                      <span className="tag">{item.resourceType || '—'}</span>
                    </td>
                    <td className="mono muted truncate" title={item.resourceId}>
                      {item.resourceId || '—'}
                    </td>
                    <td
                      className="mono muted truncate"
                      title={item.username || item.userId || item.actorId}
                    >
                      {item.username || item.userId || item.actorId || '系统'}
                    </td>
                    <td className="muted nowrap">{formatTime(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
