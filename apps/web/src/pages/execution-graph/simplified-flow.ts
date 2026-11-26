import type { DeploymentSelection } from '../../models';
import {
  effectiveNodeType,
  graphNodeLabels,
  isReleaseNode,
  type GraphArtifactType,
  type GraphField,
  type GraphFlow,
  type GraphNode,
} from './execution-graph-definition';

export const simplifiedModel = 'FLOW_V2' as const;

export type SimplifiedGitRef = { kind: 'BRANCH' | 'TAG' | 'COMMIT'; value: string };

export interface SimplifiedSource {
  id: string;
  repositoryId?: string;
  ref?: SimplifiedGitRef;
}

export interface SimplifiedExecution {
  location: 'INHERIT' | 'MANAGER' | 'TARGET';
  serverId?: string;
  groupId?: string;
}

export interface SimplifiedRelease {
  serviceId?: string;
  targets?: DeploymentSelection;
  artifactSource?: 'RUN_PARAMETER';
  artifactId?: string;
  allowArtifactOverride?: boolean;
  useUpstreamArtifact?: boolean;
  upstreamArtifactName?: string;
  imageId?: string;
  compose?: { sourceId?: string; path: string };
}

export interface SimplifiedVariable {
  key: string;
  value?: string;
  credentialId?: string;
  allowOverride?: boolean;
}

export interface SimplifiedStart {
  sources?: SimplifiedSource[];
  execution?: SimplifiedExecution;
  release?: SimplifiedRelease;
  environmentSetId?: string;
  variables?: SimplifiedVariable[];
  dotenv?: { sourceId: string; path: string };
}

export interface SimplifiedFinish {
  saveWorkspace?: boolean;
  retention?: 'PERSISTENT' | 'RUN';
  images?: SimplifiedFinishImage[];
  requireRelease?: 'ACTIVATED' | 'HEALTHY';
}

export interface SimplifiedFinishImage {
  id: string;
  name: string;
  source: 'BUILT_IN' | 'WORKSPACE' | 'REGISTRY';
  reference?: string;
  registryId?: string;
  composePath?: string;
}

export const simplifiedActions = [
  'CHECKOUT',
  'SHELL',
  'CHECK',
  'BUILD',
  'DEPLOY_ARTIFACT',
  'ROLLBACK_ARTIFACT',
  'HEALTH_CHECK',
  'APPROVAL',
  'SOURCE_REVIEW',
  'DELAY',
] as const;

export type SimplifiedAction = (typeof simplifiedActions)[number];

export const simplifiedNodeGroups = [
  { name: '常用节点', types: ['START', 'END', 'CHECKOUT', 'SHELL', 'BUILD', 'DEPLOY_ARTIFACT'] },
  { name: '流程控制', types: ['CONDITION', 'DELAY'] },
  { name: '审核与发布', types: ['SOURCE_REVIEW', 'APPROVAL', 'HEALTH_CHECK', 'ROLLBACK_ARTIFACT'] },
] as const;

export function isSimplifiedAction(type: GraphNode['type']): type is SimplifiedAction {
  return simplifiedActions.some((action) => action === type);
}

export function simplifiedNodeLabel(type: GraphNode['type']) {
  if (type === 'SHELL') return '执行命令';
  if (type === 'APPROVAL') return '发布审批';
  return graphNodeLabels[type];
}

export const simplifiedConditionField = 'conditionValue';
export const simplifiedWorkspaceArtifactField = 'workspaceArtifactId';

export function isNativeDockerBuild(node: GraphNode) {
  return effectiveNodeType(node) === 'BUILD' && Boolean(node.build?.dockerfilePath?.trim());
}

export function producesWorkspace(node: GraphNode) {
  return ['CHECKOUT', 'SHELL', 'CHECK', 'BUILD'].includes(effectiveNodeType(node));
}

export function simplifiedWorkspaceInput(flow: GraphFlow): GraphField | undefined {
  if (
    flow.model !== simplifiedModel ||
    flow.nodes.some((node) => isReleaseNode(node) || effectiveNodeType(node) === 'SOURCE_REVIEW') ||
    !flow.nodes.some((node) => ['BUILD', 'SHELL', 'CHECK'].includes(effectiveNodeType(node)))
  )
    return;
  const start = flow.nodes.find(({ type }) => type === 'START');
  return {
    id: simplifiedWorkspaceArtifactField,
    name: '历史目录',
    type: 'ARTIFACT',
    required:
      flow.nodes.some((node) => effectiveNodeType(node) === 'CHECKOUT') &&
      !start?.start?.sources?.length,
    acceptedArtifactTypes: ['DIRECTORY'],
  };
}

export function simplifiedReleaseInput(
  flow: GraphFlow,
  type?: GraphArtifactType,
): GraphField | undefined {
  const release = flow.nodes.find(({ type }) => type === 'START')?.start?.release;
  const action = flow.nodes.find(isReleaseNode);
  const runtimeArtifact = release?.artifactSource === 'RUN_PARAMETER';
  if ((!release?.allowArtifactOverride && !runtimeArtifact) || !action) return;
  const kinds = simplifiedReleaseKinds(action.deploy?.method);
  if (type && !kinds.includes(type)) return;
  return {
    id: 'artifactId',
    name: '已登记产物',
    type: 'ARTIFACT',
    required: runtimeArtifact || Boolean(release?.useUpstreamArtifact),
    defaultValue: release?.artifactId,
    acceptedArtifactTypes: kinds,
  };
}

export function simplifiedReleaseKinds(method?: 'FILE' | 'COMPOSE'): GraphArtifactType[] {
  return method === 'COMPOSE' ? ['DOCKER_IMAGE'] : ['FILE', 'DIRECTORY'];
}

export interface SimplifiedPublicPlan {
  location: 'MANAGER' | 'TARGET';
  serverId?: string;
  serverName?: string;
  sources: {
    id: string;
    repositoryId: string;
    repositoryName?: string;
    commitSha: string;
    ref?: string;
    branch?: string;
    tag?: string;
    path: string;
  }[];
  finish: SimplifiedFinish;
  workspaceRetention?: 'PERSISTENT' | 'RUN' | 'OFF';
  imageTagVariable?: string;
  imageTag?: string;
  release?: {
    serviceId: string;
    serverIds: string[];
    artifactId?: string;
    contentPath?: string;
    method: string;
    image?: { id: string; name: string };
    compose?: { sourceId?: string; path: string };
  };
  workspacePath?: string;
  workspaceSource?:
    | { kind: 'NEW' }
    | {
        kind: 'HISTORICAL';
        artifactId: string;
        runId: string;
        createdAt: number;
        sizeBytes: number | null;
        sources: {
          repositoryId: string;
          ref?: string;
          commitSha: string;
          checkoutPath?: string;
        }[];
      };
  artifacts?: {
    id: string;
    name: string;
    kind: string;
    checksum?: string | null;
    digest?: string | null;
    commitSha?: string | null;
    temporary?: boolean;
    lifecycleState?: 'ACTIVE' | 'CLEANING' | 'DELETED';
    imageReference?: string;
  }[];
}

export function simplifiedRuntimeInputs(flow: GraphFlow): GraphField[] {
  const start = flow.nodes.find(({ type }) => type === 'START')?.start;
  const artifact = simplifiedReleaseInput(flow);
  const workspace = simplifiedWorkspaceInput(flow);
  return [
    ...(workspace ? [workspace] : []),
    ...(start?.variables ?? []).flatMap((variable) =>
      variable.allowOverride && !variable.credentialId
        ? [
            {
              id: 'var:' + variable.key,
              name: variable.key,
              type: 'TEXT' as const,
              required: false,
              defaultValue: variable.value,
            },
          ]
        : [],
    ),
    ...(artifact ? [artifact] : []),
    ...(flow.nodes.some(
      (node) =>
        ['CONDITION', 'SWITCH'].includes(effectiveNodeType(node)) &&
        !(node.condition ?? node.branch ?? node.switch)?.parameterKey,
    )
      ? [{ id: simplifiedConditionField, name: '条件值', type: 'TEXT' as const, required: false }]
      : []),
  ];
}

export function simplifiedSourceDirectory(url: string) {
  let name: string;
  try {
    const address = new URL(url);
    if (address.protocol !== 'http:' && address.protocol !== 'https:') return;
    name = decodeURIComponent(address.pathname.replace(/\/+$/, '').split('/').at(-1) ?? '').replace(
      /\.git$/i,
      '',
    );
  } catch {
    return;
  }
  if (
    !name.trim() ||
    name.includes('/') ||
    name.includes('\\') ||
    /^[a-z]:/i.test(name) ||
    name === '.' ||
    name === '..' ||
    /^\.(git|veyops)$/i.test(name) ||
    Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return;
  return name;
}
