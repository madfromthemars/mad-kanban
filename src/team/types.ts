export interface TeamUser {
  id: string;
  name: string;
}

export interface TeamBoardMeta {
  id: string;
  name: string;
  version: number;
  created_at?: number;
  joined?: boolean;
  member_count?: number;
  settings?: Record<string, any>;
}

export interface TeamLane {
  id: string;
  title: string;
  position: number;
  markComplete: boolean;
  maxItems: number;
}

export interface TeamCard {
  id: string;
  boardId: string;
  laneId: string | null;
  position: number;
  content: string;
  checked: boolean;
  checkChar: string;
  assignees: string[];
  version: number;
  archived: boolean;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  lastMoved: number;
  commentCount?: number;
}

export interface TeamComment {
  id: string;
  cardId: string;
  userId: string;
  userName: string | null;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface UploadedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export interface MyCard extends TeamCard {
  boardName: string;
  laneTitle: string | null;
}

export interface TeamBoardSnapshot {
  board: TeamBoardMeta;
  lanes: TeamLane[];
  cards: TeamCard[];
  archive: TeamCard[];
  members: TeamUser[];
}

export type TeamOp =
  | { type: 'lane.create'; id: string; title: string; index: number; markComplete?: boolean; maxItems?: number }
  | { type: 'lane.update'; id: string; title?: string; markComplete?: boolean; maxItems?: number }
  | { type: 'lane.delete'; id: string }
  | { type: 'lane.setOrder'; laneIds: string[] }
  | { type: 'lane.setCards'; laneId: string; cardIds: string[] }
  | {
      type: 'card.create';
      id: string;
      laneId: string;
      index: number;
      content: string;
      checked?: boolean;
      checkChar?: string;
      assignees?: string[];
    }
  | {
      type: 'card.update';
      id: string;
      version?: number;
      content?: string;
      checked?: boolean;
      checkChar?: string;
      assignees?: string[];
    }
  | { type: 'card.assign'; id: string; userId?: string; assigned: boolean }
  | {
      type: 'card.move';
      id: string;
      laneId?: string;
      laneTitle?: string;
      index?: number;
      checked?: boolean;
      checkChar?: string;
    }
  | { type: 'board.settings'; set: Record<string, any> }
  | { type: 'board.addTagColors'; colors: Array<{ tagKey: string; color: string; backgroundColor: string }> }
  | { type: 'card.archive'; id: string }
  | { type: 'card.delete'; id: string };

export interface OpsResponse {
  ok: boolean;
  version: number;
  results: Array<{ i: number; type: string; ok: boolean; error?: string; id?: string }>;
  conflicts: Array<{ id: string; version: number; card: TeamCard }>;
  versions: Record<string, number>;
}

export type TeamServerEvent =
  | { type: 'hello'; user: TeamUser }
  | {
      type: 'board.changed';
      boardId: string;
      version: number;
      origin?: string | null;
      users?: string[];
      cards?: string[];
    }
  | { type: 'boards.changed'; boardId?: string; deleted?: boolean }
  | { type: 'comments.changed'; boardId: string; cardId: string }
  | { type: 'pong' };

/** Frontmatter keys written into a team board's markdown file. */
export const teamBoardIdKey = 'kanban-team-board';
export const teamBoardNameKey = 'kanban-team-name';
