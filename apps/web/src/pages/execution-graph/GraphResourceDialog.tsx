import { createPortal } from 'react-dom';
import type { ProjectDetail, Repository, Service, User } from '../../models';
import { ProjectRepositoryEditor } from '../projects/repositories/ProjectRepositoryEditor';
import { ProjectServiceEditor } from '../projects/ProjectServiceEditor';

type GraphResourceDialogProps = {
  project: ProjectDetail;
  role: User['role'];
  onClose: () => void;
} & (
  | {
      kind: 'repository';
      initialUrl?: string;
      onSaved: (repository: Repository) => void | Promise<void>;
    }
  | { kind: 'service'; onSaved: (service: Service) => void | Promise<void> }
);

export function GraphResourceDialog(props: GraphResourceDialogProps) {
  const { project, role, onClose } = props;
  if (role === 'VIEWER' || project.archived) return null;
  return createPortal(
    props.kind === 'repository' ? (
      <ProjectRepositoryEditor
        projectId={project.id}
        role={role}
        initialUrl={props.initialUrl}
        modal
        onClose={onClose}
        onSaved={props.onSaved}
      />
    ) : (
      <ProjectServiceEditor
        projectId={project.id}
        modal
        onClose={onClose}
        onSaved={props.onSaved}
      />
    ),
    document.body,
  );
}
