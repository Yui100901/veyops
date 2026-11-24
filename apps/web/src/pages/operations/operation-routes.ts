export const operationsTabs = {
  commands: '临时命令',
  templates: '命令模板',
  plans: '运维方案',
  schedules: '定时运维',
};
export type OperationsTab = keyof typeof operationsTabs;

export function operationsTabForPath(path: string): OperationsTab | undefined {
  if (path === '/operations' || path === '/commands') return 'commands';
  if (path === '/plans') return 'plans';
  if (path === '/tasks/schedules') return 'schedules';
  const [, root, tab, extra] = path.split('/');
  if (root === 'operations' && tab && extra === undefined && Object.hasOwn(operationsTabs, tab))
    return tab as OperationsTab;
}
