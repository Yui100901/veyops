import { useResource } from '../../api';
import { ErrorBanner, Loading } from '../../components';
import type { ProjectDetail, User } from '../../models';
import { ExecutionGraphRunDetails } from '../execution-graph/run/ExecutionGraphHistory';

export default function ExecutionFlowTask({
  projectId,
  runId,
  user,
  nodeId,
}: {
  projectId: string;
  runId: string;
  user: User;
  nodeId?: string;
}) {
  const path = '/projects/' + encodeURIComponent(projectId);
  const project = useResource<ProjectDetail>(path + '/delivery-context');
  if (project.loading) return <Loading />;
  if (!project.data)
    return <ErrorBanner error={project.error || '项目不可用'} retry={project.reload} />;

  const canOperate = !project.data.archived && user.role !== 'VIEWER';
  return (
    <ExecutionGraphRunDetails
      key={runId}
      path={path + '/execution-graph/runs/' + encodeURIComponent(runId)}
      project={project.data}
      selectedNodeId={nodeId}
      canCancel={canOperate}
      canApprove={canOperate && user.role === 'ADMIN'}
      userId={user.id}
      taskCenter
    />
  );
}
