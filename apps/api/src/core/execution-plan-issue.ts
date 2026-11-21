import { HttpException } from '@nestjs/common';

export interface ExecutionPlanIssue {
  code:
    | 'INPUT'
    | 'REPOSITORY'
    | 'BUILD_TARGET'
    | 'RELEASE_TARGET'
    | 'ARTIFACT'
    | 'SOURCE_REVIEW'
    | 'CONFIGURATION';
  message: string;
  flowId?: string;
  flowName?: string;
  nodeId?: string;
  nodeName?: string;
  fieldId?: string;
  fieldName?: string;
  parameterId?: string;
  serviceId?: string;
  environmentId?: string;
  targetSource?:
    'RUN_INPUT' | 'NODE' | 'SERVICE_ENVIRONMENT' | 'PROJECT_ENVIRONMENT' | 'LEGACY_TARGET';
  repositoryId?: string;
  commitSha?: string;
}

export class ExecutionPlanIssueError extends HttpException {
  constructor(
    readonly issue: ExecutionPlanIssue,
    status = 400,
  ) {
    super(issue.message, status);
  }
}

export function executionIssue(
  error: HttpException,
  location: Omit<ExecutionPlanIssue, 'message'>,
) {
  return new ExecutionPlanIssueError({ ...location, message: error.message }, error.getStatus());
}
