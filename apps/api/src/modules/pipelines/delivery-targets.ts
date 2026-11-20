import {
  directDeploymentSelection,
  type DeploymentSelection,
  type DeploymentSelectionDto,
} from '../deployment-targets/deployment-selection';

export type DeliveryTargetSource =
  'MANAGER' | 'RUN_INPUT' | 'SERVICE_ENVIRONMENT' | 'PROJECT_ENVIRONMENT' | 'LEGACY_TARGET';

export function resolveDeliveryTargets(
  purpose: 'MANAGER_BUILD' | 'TARGET_BUILD' | 'RELEASE',
  input: DeploymentSelectionDto,
  defaults: {
    environment?: DeploymentSelection;
    service?: DeploymentSelection | null;
    legacyTargetId?: string | null;
    parallel: number;
  },
): { source: DeliveryTargetSource; selection?: DeploymentSelection; legacyId?: string } {
  if (purpose === 'MANAGER_BUILD') return { source: 'MANAGER' };

  if (input.targetId && input.serverIds === undefined && input.groupIds === undefined)
    return { source: 'LEGACY_TARGET', legacyId: input.targetId };

  const release = purpose === 'RELEASE';
  const configured = release ? (defaults.service ?? defaults.environment) : undefined;
  const direct = directDeploymentSelection(
    {
      ...input,
      strategy: input.strategy ?? configured?.strategy,
      maxParallel: input.maxParallel ?? configured?.maxParallel,
      failurePolicy: input.failurePolicy ?? configured?.failurePolicy,
    },
    defaults.parallel,
  );
  if (direct) return { source: 'RUN_INPUT', selection: direct };
  if (release && !defaults.service && defaults.legacyTargetId)
    return { source: 'LEGACY_TARGET', legacyId: defaults.legacyTargetId };
  if (!configured) return { source: 'RUN_INPUT' };
  return {
    source: defaults.service ? 'SERVICE_ENVIRONMENT' : 'PROJECT_ENVIRONMENT',
    selection: {
      ...configured,
      strategy: input.strategy ?? configured.strategy,
      maxParallel: input.maxParallel ?? configured.maxParallel,
      failurePolicy: input.failurePolicy ?? configured.failurePolicy,
    },
  };
}
