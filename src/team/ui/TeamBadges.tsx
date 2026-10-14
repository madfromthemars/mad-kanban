import classcat from 'classcat';
import { memo, useContext } from 'preact/compat';
import { KanbanContext } from 'src/components/context';
import { c } from 'src/components/helpers';
import { Item } from 'src/components/types';

import { parseTeamItemId } from '../ids';
import { AssigneeModal } from './modals';
import { Icon } from 'src/components/Icon/Icon';

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function hueFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export const AssigneeChips = memo(function AssigneeChips({
  assignees,
  onClick,
  compact,
}: {
  assignees: string[];
  onClick?: (e: MouseEvent) => void;
  compact?: boolean;
}) {
  const { stateManager } = useContext(KanbanContext);
  const team = stateManager.plugin?.team;
  const users = team ? team.useUsers() : [];
  const me = team?.user?.id;
  if (!assignees?.length) return null;

  return (
    <div
      className={classcat([c('assignees'), { 'is-compact': compact }])}
      data-ignore-drag={true}
      onClick={onClick}
    >
      {assignees.map((id) => {
        const name = users.find((u) => u.id === id)?.name || id;
        return (
          <span
            key={id}
            className={classcat([c('assignee'), { 'is-me': id === me }])}
            style={{ '--assignee-hue': hueFor(id) }}
            aria-label={name}
            title={name}
          >
            {initials(name)}
          </span>
        );
      })}
    </div>
  );
});

/**
 * Footer extras for team cards: assignee chips on team boards, and the
 * "Board · Lane" badge for cards mirrored into a personal board.
 */
export const TeamCardExtras = memo(function TeamCardExtras({
  item,
  detail,
}: {
  item: Item;
  detail?: boolean;
}) {
  const { stateManager } = useContext(KanbanContext);
  const team = stateManager.plugin?.team;
  const parsed = parseTeamItemId(item.id);
  const info = team ? team.useCardInfo(parsed?.cardId ?? null) : null;

  if (!team || !parsed) return null;

  const isMirror = !stateManager.teamSync;
  const assignees = info?.card.assignees || [];
  const project = team.project(info?.card.projectId);

  const openPicker = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only people in the card's project can see it, so only they can be assigned.
    const people = project ? team.users.filter((u) => project.memberIds.includes(u.id)) : team.users;
    new AssigneeModal(stateManager.app, people, assignees, (user) => {
      void team.toggleAssignee(parsed.boardId, parsed.cardId, user.id);
    }).open();
  };

  const openBoard = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void team.openBoard(parsed.boardId);
  };

  return (
    <div className={c('team-extras')} data-ignore-drag={true}>
      {!detail && <ProjectChip projectId={info?.card.projectId} />}
      {isMirror && (
        <a className={c('team-badge')} onClick={openBoard} title="Open team board">
          <span className={c('team-badge-board')}>
            {info?.boardName || team.boardNames.get(parsed.boardId) || 'Team'}
          </span>
          {info?.laneTitle && <span className={c('team-badge-lane')}>{info.laneTitle}</span>}
        </a>
      )}
      {!detail && (info?.card.unreadComments || 0) > 0 ? (
        <span
          className={`${c('comment-count')} is-unread`}
          title={`${info.card.unreadComments} unread comment${info.card.unreadComments === 1 ? '' : 's'} (${info.card.commentCount} total)`}
        >
          <Icon name="lucide-message-square" />
          {info.card.unreadComments} new
        </span>
      ) : !detail && (info?.card.editedComments || 0) > 0 ? (
        <span
          className={`${c('comment-count')} is-unread is-edited`}
          title={`${info.card.editedComments} comment${info.card.editedComments === 1 ? ' was' : 's were'} edited since you read ${info.card.editedComments === 1 ? 'it' : 'them'}`}
        >
          <Icon name="lucide-message-square" />
          {info.card.editedComments} edited
        </span>
      ) : (
        !detail &&
        (info?.card.commentCount || 0) > 0 && (
          <span className={c('comment-count')} title="Comments (all read)">
            <Icon name="lucide-message-square" />
            {info.card.commentCount}
          </span>
        )
      )}
      {assignees.length > 0 && (
        <AssigneeChips assignees={assignees} onClick={openPicker} compact={!detail} />
      )}
      {(detail || (!isMirror && !assignees.length)) && (
        <a className={c('assign-button')} onClick={openPicker} title="Assign">
          {detail ? '+ Assign' : '+'}
        </a>
      )}
    </div>
  );
});

/** The card's project, on cards; hidden when the user only has one project. */
export const ProjectChip = memo(function ProjectChip({ projectId }: { projectId?: string | null }) {
  const { stateManager } = useContext(KanbanContext);
  const team = stateManager.plugin?.team;
  const projects = team ? team.useProjects() : [];
  const project = projectId ? projects.find((p) => p.id === projectId) : null;
  if (!project || projects.length < 2) return null;
  return (
    <span
      className={c('project-chip')}
      style={{ '--project-color': project.color || 'var(--text-muted)' }}
      title={`Project: ${project.name}`}
    >
      <span className={c('project-dot')} />
      {project.name}
    </span>
  );
});

/** Project field in the card window: shows the project and moves the card to another one. */
export function ProjectSelect({ item }: { item: Item }) {
  const { stateManager } = useContext(KanbanContext);
  const team = stateManager.plugin?.team;
  const parsed = parseTeamItemId(item.id);
  const info = team ? team.useCardInfo(parsed?.cardId ?? null) : null;
  const projects = team ? team.useProjects() : [];
  if (!team || !parsed || !projects.length) return null;
  const current = info?.card.projectId || '';
  const project = projects.find((p) => p.id === current);
  return (
    <div className={c('cd-project')} style={{ '--project-color': project?.color || 'var(--text-faint)' }}>
      <span className={c('project-dot')} />
      <select
        className={`dropdown ${c('cd-select')}`}
        value={current}
        onChange={(e) => {
          const next = (e.target as HTMLSelectElement).value;
          if (next && next !== current) void team.setCardProject(parsed.boardId, parsed.cardId, next);
        }}
      >
        {!project && <option value="">No project</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Small status pill shown in the toolbar of a team board. */
export const TeamSyncStatus = memo(function TeamSyncStatus() {
  const { stateManager } = useContext(KanbanContext);
  const team = stateManager.plugin?.team;
  const sync = stateManager.teamSync;
  const st = team ? team.useSyncState(sync) : null;
  if (!team || !sync || !st) return null;

  const info: Record<string, { icon: string; text: string }> = {
    synced: { icon: 'lucide-cloud', text: 'Team board · synced' },
    syncing: { icon: 'lucide-cloud', text: 'Team board · syncing…' },
    loading: { icon: 'lucide-cloud', text: 'Team board · loading…' },
    offline: { icon: 'lucide-cloud', text: 'Team board · offline (showing the last loaded copy)' },
    error: { icon: 'lucide-cloud', text: 'Team board · sync error' },
  };
  const { icon, text } = info[st.state] || info.error;

  return (
    <a
      className={classcat([c('team-status'), `is-${st.state}`])}
      aria-label={`${text}${st.error ? ` — ${st.error}` : ''}. Click to resync.`}
      onClick={(e) => {
        e.preventDefault();
        void sync.load();
      }}
    >
      <Icon name={icon} />
    </a>
  );
});
