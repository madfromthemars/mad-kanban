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

  const openPicker = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    new AssigneeModal(stateManager.app, team.users, assignees, (user) => {
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

/** Small status pill shown in the toolbar of a team board. */
export const TeamSyncStatus = memo(function TeamSyncStatus() {
  const { stateManager } = useContext(KanbanContext);
  const team = stateManager.plugin?.team;
  const sync = stateManager.teamSync;
  const st = team ? team.useSyncState(sync) : null;
  if (!team || !sync || !st) return null;

  const label =
    st.state === 'synced'
      ? 'Team · synced'
      : st.state === 'syncing'
        ? 'Team · syncing…'
        : st.state === 'loading'
          ? 'Team · loading…'
          : st.state === 'offline'
            ? 'Team · offline'
            : 'Team · error';

  return (
    <a
      className={classcat([c('team-status'), `is-${st.state}`])}
      title={st.error || 'Click to resync'}
      onClick={(e) => {
        e.preventDefault();
        void sync.load();
      }}
    >
      {label}
    </a>
  );
});
