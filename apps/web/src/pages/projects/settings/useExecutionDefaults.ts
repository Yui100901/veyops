import { useResource } from '../../../api';
import type { ProjectExecutionSettings, SystemRuntimeDefaults } from '../../../models';

export function useExecutionDefaults(projectId?: string) {
  const resource = useResource<ProjectExecutionSettings | SystemRuntimeDefaults>(
    projectId ? `/projects/${projectId}/execution-settings` : '/system',
  );
  const data = resource.data;
  return { ...resource, data: data && ('effective' in data ? data.effective : data) };
}
