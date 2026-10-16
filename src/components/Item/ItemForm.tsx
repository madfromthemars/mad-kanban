import { App, Modal, Notice, TFile } from 'obsidian';
import { Dispatch, StateUpdater, useContext, useEffect, useRef } from 'preact/hooks';
import { t } from 'src/lang/helpers';
import {
  addCardLinkToListFile,
  addBoardLinkToListFile,
  buildCardContent,
  buildCardFileContent,
  buildCardFilename,
  ensureFolder,
  getListFilePath,
  getListFolderPath,
  sanitizeName,
} from 'src/kanbanFileHelpers';

import { getDropAction } from '../Editor/helpers';
import { KanbanContext } from '../context';
import { c } from '../helpers';
import { EditState, EditingState, Item, isEditing } from '../types';
import { TeamProject, TeamUser } from 'src/team/types';
import { hueFor, initials } from 'src/team/ui/TeamBadges';

interface ItemFormProps {
  addItems: (items: Item[]) => void;
  editState: EditState;
  setEditState: Dispatch<StateUpdater<EditState>>;
  hideButton?: boolean;
  listTitle: string;
}

interface NewCard {
  name: string;
  projectId?: string;
  assignees: string[];
}

const lastProjectKey = (boardId: string) => `mad-kanban:last-project:${boardId}`;

class NewCardModal extends Modal {
  defaultValue: string;
  onSubmit: (value: NewCard | null) => void;
  submitted: boolean = false;
  inputEl: HTMLInputElement;
  projects: TeamProject[];
  boardId: string | null;
  projectId: string | undefined;
  users: TeamUser[];
  meId: string | null;
  assignees = new Set<string>();
  drawPeople: () => void = () => {};

  constructor(
    app: App,
    defaultValue: string,
    onSubmit: (value: NewCard | null) => void,
    projects: TeamProject[] = [],
    boardId: string | null = null,
    users: TeamUser[] = [],
    meId: string | null = null
  ) {
    super(app);
    this.users = users;
    this.meId = meId;
    this.defaultValue = defaultValue;
    this.onSubmit = onSubmit;
    this.projects = projects;
    this.boardId = boardId;
    let last: string | null = null;
    try {
      last = boardId ? activeWindow.localStorage.getItem(lastProjectKey(boardId)) : null;
    } catch {
      /* storage unavailable */
    }
    this.projectId = (projects.find((p) => p.id === last) || projects[0])?.id;
  }

  renderProjects(parent: HTMLElement) {
    if (!this.projects.length) return;
    const field = parent.createDiv({ cls: 'kanban-plugin__new-card-projects' });
    field.createDiv({ cls: 'kanban-plugin__new-card-label', text: 'Project' });
    const pills = field.createDiv({ cls: 'kanban-plugin__project-pills' });
    const draw = () => {
      pills.empty();
      for (const p of this.projects) {
        const pill = pills.createEl('button', {
          cls: `kanban-plugin__project-pill${p.id === this.projectId ? ' is-selected' : ''}`,
          attr: { type: 'button', 'aria-pressed': String(p.id === this.projectId) },
        });
        pill.style.setProperty('--project-color', p.color || 'var(--text-muted)');
        pill.createSpan({ cls: 'kanban-plugin__project-dot' });
        pill.createSpan({ text: p.name });
        pill.addEventListener('click', () => {
          this.projectId = p.id;
          draw();
          this.drawPeople();
          this.inputEl.focus();
        });
      }
    };
    draw();
  }

  /** People who can be assigned: members of the chosen project, me first. */
  assignable() {
    const project = this.projects.find((p) => p.id === this.projectId);
    const people = project ? this.users.filter((u) => project.memberIds.includes(u.id)) : this.users;
    return [...people].sort((a, b) => (a.id === this.meId ? -1 : b.id === this.meId ? 1 : a.name.localeCompare(b.name)));
  }

  renderPeople(parent: HTMLElement) {
    if (!this.users.length) return;
    const field = parent.createDiv({ cls: 'kanban-plugin__new-card-projects' });
    field.createDiv({ cls: 'kanban-plugin__new-card-label', text: 'Assign to' });
    const pills = field.createDiv({ cls: 'kanban-plugin__project-pills' });
    this.drawPeople = () => {
      pills.empty();
      const people = this.assignable();
      // Switching project drops people who could no longer see the card.
      for (const id of [...this.assignees]) if (!people.some((u) => u.id === id)) this.assignees.delete(id);
      if (!people.length) {
        pills.createSpan({ cls: 'kanban-plugin__new-card-empty', text: 'No one is in this project yet.' });
        return;
      }
      for (const u of people) {
        const on = this.assignees.has(u.id);
        const pill = pills.createEl('button', {
          cls: `kanban-plugin__project-pill kanban-plugin__person-pill${on ? ' is-selected' : ''}`,
          attr: { type: 'button', 'aria-pressed': String(on) },
        });
        pill.style.setProperty('--project-color', `hsl(${hueFor(u.id)}, 55%, 50%)`);
        pill.style.setProperty('--assignee-hue', String(hueFor(u.id)));
        pill.createSpan({ cls: 'kanban-plugin__assignee', text: initials(u.name) });
        pill.createSpan({ text: u.id === this.meId ? `${u.name} (me)` : u.name });
        pill.addEventListener('click', () => {
          if (on) this.assignees.delete(u.id);
          else this.assignees.add(u.id);
          this.drawPeople();
          this.inputEl.focus();
        });
      }
    };
    this.drawPeople();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('kanban-plugin__new-card-modal');
    this.modalEl.addClass('kanban-plugin__new-card-window');

    contentEl.createEl('h2', { text: t('Add card') });

    this.inputEl = contentEl.createEl('input', {
      type: 'text',
      placeholder: t('Card title...'),
    });
    this.inputEl.addClass('kanban-plugin__new-board-input');
    this.inputEl.value = this.defaultValue;
    this.inputEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        this.submit();
      }
    });
    this.renderProjects(contentEl);
    this.renderPeople(contentEl);

    const actions = contentEl.createDiv({ cls: 'kanban-plugin__new-board-actions' });
    const createButton = actions.createEl('button', { text: t('Add card'), cls: 'mod-cta' });
    const cancelButton = actions.createEl('button', { text: t('Cancel') });

    createButton.addEventListener('click', () => this.submit());
    cancelButton.addEventListener('click', () => this.close());

    setTimeout(() => this.inputEl.focus(), 0);
  }

  submit() {
    if (this.submitted) return;
    this.submitted = true;
    if (this.boardId && this.projectId) {
      try {
        activeWindow.localStorage.setItem(lastProjectKey(this.boardId), this.projectId);
      } catch {
        /* storage unavailable */
      }
    }
    this.onSubmit({ name: this.inputEl.value, projectId: this.projectId, assignees: [...this.assignees] });
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.submitted) {
      this.onSubmit(null);
    }
  }
}

function promptNewCard(
  app: App,
  defaultValue: string,
  projects?: TeamProject[],
  boardId?: string | null,
  users?: TeamUser[],
  meId?: string | null
): Promise<NewCard | null> {
  return new Promise((resolve) => {
    const modal = new NewCardModal(
      app,
      defaultValue,
      (value) => resolve(value),
      projects,
      boardId,
      users,
      meId
    );
    modal.open();
  });
}

export function ItemForm({
  addItems,
  editState,
  setEditState,
  hideButton,
  listTitle,
}: ItemFormProps) {
  const { stateManager } = useContext(KanbanContext);
  const isPromptingRef = useRef(false);

  const createItem = async (description: string) => {
    const defaultName = description.trim();
    const sync = stateManager.teamSync;
    // Cards can only be added to projects the user is in.
    const team = stateManager.plugin?.team;
    if (sync && team?.user && !team.projects.length) {
      new Notice('Kanban: you are not in any project yet. Ask a host to add you to one.');
      return;
    }
    const picked = await promptNewCard(
      stateManager.app,
      defaultName,
      sync ? team?.projects : undefined,
      sync?.boardId,
      sync ? team?.users : undefined,
      team?.user?.id
    );
    if (picked === null) return;
    const name = picked.name;

    const trimmedName = name.trim();
    if (!trimmedName) return;

    if (sync) {
      // Team cards live on the server; no per-card note is created.
      const body = description.trim();
      const content = body && body !== trimmedName ? `${trimmedName}\n${body}` : trimmedName;
      const item = stateManager.getNewItem(content, ' ');
      const data = { ...item.data };
      if (picked.projectId) data.teamProject = picked.projectId;
      if (picked.assignees.length) data.teamAssignees = picked.assignees;
      addItems([{ ...item, data }]);
      return;
    }

    const sanitizedName = sanitizeName(trimmedName);

    if (!sanitizedName) return;

    const vault = stateManager.app.vault;
    const listFolderPath = getListFolderPath(stateManager.file, listTitle);
    await ensureFolder(vault, listFolderPath);

    const cardFileName = buildCardFilename(trimmedName, new Date());
    const cardFilePath = `${listFolderPath}/${cardFileName}`;

    const descriptionBody = description.trim();
    const bodyContent = descriptionBody && descriptionBody !== trimmedName ? descriptionBody : '';
    const cardContent = buildCardFileContent(bodyContent);
    await vault.create(cardFilePath, cardContent);
    const listFilePath = getListFilePath(stateManager.file, listTitle);
    await addBoardLinkToListFile(stateManager.app, listFilePath, stateManager.file.path);
    await addCardLinkToListFile(
      stateManager.app,
      listFilePath,
      cardFilePath
    );

    const itemContent = buildCardContent(cardFilePath, trimmedName, description);
    addItems([stateManager.getNewItem(itemContent, ' ')]);
  };

  useEffect(() => {
    if (!isEditing(editState) || isPromptingRef.current) return;
    isPromptingRef.current = true;
    void createItem('')
      .catch((e) => { console.error(e); new Notice('Kanban: Error creating card' + (e instanceof Error ? ': ' + e.message : '')); })
      .finally(() => {
        isPromptingRef.current = false;
        setEditState(EditingState.cancel);
      });
  }, [editState, setEditState]);

  if (hideButton) return null;

  return (
    <div className={c('item-button-wrapper')}>
      <button
        className={c('new-item-button')}
        onClick={() => {
          void createItem('');
        }}
        onDragOver={(e) => {
          if (getDropAction(stateManager, e.dataTransfer)) {
            void createItem('');
          }
        }}
      >
        <span className={c('item-button-plus')}>+</span> {t('Add a card')}
      </button>
    </div>
  );
}
