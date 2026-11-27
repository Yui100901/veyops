import { BadRequestException } from '@nestjs/common';
import type { ExecutionStep } from '../tasks/tasks.types';

export const operationPackageManagers = [
  'apt-get',
  'dnf',
  'yum',
  'zypper',
  'apk',
  'pacman',
] as const;
export type OperationPackageManager = (typeof operationPackageManagers)[number];
export type OperationFact = 'OS' | 'PACKAGE_MANAGER';

export interface OperationChainNode {
  id: string;
  type: 'START' | 'COMMAND' | 'CONDITION' | 'END';
  name: string;
  x: number;
  y: number;
  command?: string;
  timeout?: number;
  failurePolicy?: 'STOP' | 'CONTINUE';
  fact?: OperationFact;
}

export interface OperationChainEdge {
  from: string;
  to: string;
  when?: string;
}

export interface OperationChain {
  nodes: OperationChainNode[];
  edges: OperationChainEdge[];
}

const factValue = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function validateOperationChain(chain: OperationChain): OperationChain {
  const fail = (message: string): never => {
    throw new BadRequestException(message);
  };
  const nodes = new Map(chain.nodes.map((node) => [node.id, node]));
  if (nodes.size !== chain.nodes.length) fail('执行链节点标识不能重复');
  const starts = chain.nodes.filter(({ type }) => type === 'START');
  if (starts.length !== 1 || !chain.nodes.some(({ type }) => type === 'END'))
    fail('执行链必须有一个开始节点及至少一个结束节点');
  if (!chain.nodes.some(({ type }) => type === 'COMMAND')) fail('请添加至少一个命令节点');

  const outgoing = new Map<string, OperationChainEdge[]>();
  for (const edge of chain.edges) {
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    if (!source || !target || source.type === 'END' || target.type === 'START')
      fail('执行链包含无效连线');
    if (edge.when !== undefined && (source!.type !== 'CONDITION' || !factValue.test(edge.when)))
      fail('分支值仅可用于条件连线，并使用小写系统标识');
    const links = outgoing.get(edge.from) ?? [];
    if (links.some(({ when }) => when === edge.when)) fail('同一节点的连线分支值不能重复');
    links.push(edge);
    outgoing.set(edge.from, links);
  }
  for (const node of chain.nodes) {
    const links = outgoing.get(node.id) ?? [];
    if (!node.name.trim()) fail('请填写节点名称');
    if (node.type === 'END') continue;
    if (node.type === 'CONDITION') {
      if (!node.fact || !links.some(({ when }) => when !== undefined))
        fail(`条件节点「${node.name}」需指定条件类型和至少一个分支值`);
      if (
        node.fact === 'PACKAGE_MANAGER' &&
        links.some(
          ({ when }) =>
            when !== undefined && !operationPackageManagers.some((manager) => manager === when),
        )
      )
        fail(`条件节点「${node.name}」包含未知包管理器`);
      continue;
    }
    if (links.length !== 1) fail(`节点「${node.name}」需要一条出线`);
    if (node.type === 'COMMAND' && !node.command?.trim()) fail(`请填写「${node.name}」的命令`);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) fail('执行链不能包含环路');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of outgoing.get(id) ?? []) visit(edge.to);
    visiting.delete(id);
    visited.add(id);
  };
  visit(starts[0]!.id);
  if (visited.size !== nodes.size) fail('请将所有节点连接至开始节点');
  return chain;
}

export type LegacyOperationSteps = {
  steps: ExecutionStep[];
  preChecks?: ExecutionStep[];
  postChecks?: ExecutionStep[];
};

export function legacyOperationSteps(definition: LegacyOperationSteps): ExecutionStep[] {
  const checks = (items: ExecutionStep[] = [], phase: 'precheck' | 'postcheck') =>
    items.map((step, index) => ({
      ...step,
      key: `${phase}-${index + 1}`,
      name: `${phase === 'precheck' ? '前置检查' : '执行后验证'} · ${step.name}`,
      failurePolicy: 'STOP' as const,
    }));
  return [
    ...checks(definition.preChecks, 'precheck'),
    ...definition.steps,
    ...checks(definition.postChecks, 'postcheck'),
  ];
}

export function legacyOperationChain(definition: LegacyOperationSteps): OperationChain {
  const nodes: OperationChainNode[] = [
    { id: 'start', type: 'START', name: '开始', x: 32, y: 42 },
    ...legacyOperationSteps(definition).map(({ name, command, timeout, failurePolicy }, index) => ({
      id: `step-${index + 1}`,
      type: 'COMMAND' as const,
      name: name.slice(0, 120),
      command,
      timeout,
      failurePolicy,
      x: 32 + ((index + 1) % 3) * 246,
      y: 42 + Math.floor((index + 1) / 3) * 112,
    })),
    { id: 'end', type: 'END', name: '结束', x: 0, y: 0 },
  ];
  const end = nodes[nodes.length - 1]!;
  end.x = 32 + ((nodes.length - 1) % 3) * 246;
  end.y = 42 + Math.floor((nodes.length - 1) / 3) * 112;
  return {
    nodes,
    edges: nodes.slice(1).map(({ id }, index) => ({ from: nodes[index]!.id, to: id })),
  };
}

export const operationFactsProbe = `export LC_ALL=C
printf 'os=%s\\n' "$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2; exit }' /etc/os-release 2>/dev/null)"
for tool in ${operationPackageManagers.join(' ')}; do
  if command -v "$tool" >/dev/null 2>&1; then printf '%s=available\\n' "$tool"; fi
done
printf 'probeComplete=1\\n'`;

const packageManagersByOs: Partial<Record<string, readonly OperationPackageManager[]>> = {
  alpine: ['apk'],
  arch: ['pacman'],
  centos: ['dnf', 'yum'],
  debian: ['apt-get'],
  fedora: ['dnf', 'yum'],
  linuxmint: ['apt-get'],
  manjaro: ['pacman'],
  ol: ['dnf', 'yum'],
  opensuse: ['zypper'],
  'opensuse-leap': ['zypper'],
  'opensuse-tumbleweed': ['zypper'],
  rhel: ['dnf', 'yum'],
  rocky: ['dnf', 'yum'],
  sles: ['zypper'],
  ubuntu: ['apt-get'],
};

export function operationFacts(
  values: Record<string, string>,
): Partial<Record<OperationFact, string>> {
  const native =
    values.os && Object.hasOwn(packageManagersByOs, values.os)
      ? packageManagersByOs[values.os]
      : undefined;
  const manager = (native ?? operationPackageManagers).find((item) => values[item] === 'available');
  return { OS: values.os, PACKAGE_MANAGER: manager };
}

export function parseOperationFacts(output: string) {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const [key, value, ...extra] = line.split('=');
    if (!key || !value || extra.length || !factValue.test(value)) continue;
    if (
      key === 'os' ||
      key === 'probeComplete' ||
      operationPackageManagers.some((item) => item === key)
    )
      values[key] = value;
  }
  if (values.probeComplete !== '1') throw new Error('未收到完整的执行目标系统信息');
  return operationFacts(values);
}

export function resolveOperationChain(
  chain: OperationChain,
  facts: Partial<Record<OperationFact, string>>,
) {
  const steps: ExecutionStep[] = [];
  const branches: string[] = [];
  const nodes = new Map(chain.nodes.map((node) => [node.id, node]));
  let node = chain.nodes.find(({ type }) => type === 'START');
  for (let index = 0; node && index < nodes.size; index += 1) {
    if (node.type === 'END') return { steps, branches };
    const links = chain.edges.filter(({ from }) => from === node!.id);
    let next: OperationChainEdge | undefined = links[0];
    if (node.type === 'COMMAND') {
      steps.push({
        key: node.id,
        name: node.name,
        command: node.command!,
        timeout: node.timeout,
        failurePolicy: node.failurePolicy,
      });
    }
    if (node.type === 'CONDITION') {
      const value = node.fact && facts[node.fact];
      next =
        (value ? links.find(({ when }) => when === value) : undefined) ??
        links.find(({ when }) => when === undefined);
      if (!next) throw new Error(`「${node.name}」没有匹配分支（${value ?? '未识别'}）`);
      branches.push(`${node.name}：${value ?? '未识别'} → ${next.when ?? '默认分支'}`);
    }
    node = next && nodes.get(next.to);
  }
  throw new Error('执行链未到达结束节点');
}
