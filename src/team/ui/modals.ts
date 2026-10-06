import { App, FuzzySuggestModal, Modal } from 'obsidian';

import { TeamBoardMeta, TeamUser } from '../types';

class TextPromptModal extends Modal {
  private value: string;
  private title: string;
  private placeholder: string;
  private onSubmit: (value: string | null) => void;
  private submitted = false;
  private inputEl: HTMLInputElement;

  constructor(
    app: App,
    title: string,
    placeholder: string,
    defaultValue: string,
    onSubmit: (value: string | null) => void
  ) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.value = defaultValue;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('kanban-plugin__new-board-modal');
    contentEl.createEl('h2', { text: this.title });
    this.inputEl = contentEl.createEl('input', { type: 'text', placeholder: this.placeholder });
    this.inputEl.addClass('kanban-plugin__new-board-input');
    this.inputEl.value = this.value;
    this.inputEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        this.submit();
      }
    });
    const actions = contentEl.createDiv({ cls: 'kanban-plugin__new-board-actions' });
    const ok = actions.createEl('button', { text: 'OK', cls: 'mod-cta' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    ok.addEventListener('click', () => this.submit());
    cancel.addEventListener('click', () => this.close());
    setTimeout(() => this.inputEl.focus(), 0);
  }

  submit() {
    if (this.submitted) return;
    this.submitted = true;
    this.onSubmit(this.inputEl.value);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.submitted) this.onSubmit(null);
  }
}

export function promptText(app: App, title: string, placeholder: string, defaultValue = '') {
  return new Promise<string | null>((resolve) => {
    new TextPromptModal(app, title, placeholder, defaultValue, resolve).open();
  });
}

export class JoinBoardModal extends FuzzySuggestModal<TeamBoardMeta> {
  boards: TeamBoardMeta[];
  localIds: Set<string>;
  onPick: (board: TeamBoardMeta) => void;

  constructor(
    app: App,
    boards: TeamBoardMeta[],
    localIds: Set<string>,
    onPick: (board: TeamBoardMeta) => void
  ) {
    super(app);
    this.boards = boards;
    this.localIds = localIds;
    this.onPick = onPick;
    this.setPlaceholder('Pick a team board to open');
  }

  getItems() {
    return this.boards;
  }

  getItemText(board: TeamBoardMeta) {
    const bits = [board.name];
    if (this.localIds.has(board.id)) bits.push('(in vault)');
    else if (board.joined) bits.push('(joined)');
    if (board.member_count) bits.push(`· ${board.member_count} member${board.member_count === 1 ? '' : 's'}`);
    return bits.join(' ');
  }

  onChooseItem(board: TeamBoardMeta) {
    this.onPick(board);
  }
}

export class AssigneeModal extends FuzzySuggestModal<TeamUser> {
  users: TeamUser[];
  assigned: Set<string>;
  onToggle: (user: TeamUser) => void;

  constructor(app: App, users: TeamUser[], assigned: string[], onToggle: (user: TeamUser) => void) {
    super(app);
    this.users = users;
    this.assigned = new Set(assigned);
    this.onToggle = onToggle;
    this.setPlaceholder('Assign or unassign a teammate');
  }

  getItems() {
    return this.users;
  }

  getItemText(user: TeamUser) {
    return `${this.assigned.has(user.id) ? '✓ ' : ''}${user.name}`;
  }

  onChooseItem(user: TeamUser) {
    this.onToggle(user);
  }
}
