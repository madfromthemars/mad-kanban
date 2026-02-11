import { App, Modal, Notice, TFile } from 'obsidian';
import { Dispatch, StateUpdater, useContext, useEffect, useRef } from 'preact/hooks';
import { t } from 'src/lang/helpers';
import {
  addCardLinkToListFile,
  addBoardLinkToListFile,
  buildCardContent,
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

interface ItemFormProps {
  addItems: (items: Item[]) => void;
  editState: EditState;
  setEditState: Dispatch<StateUpdater<EditState>>;
  hideButton?: boolean;
  listTitle: string;
}

class NewCardModal extends Modal {
  defaultValue: string;
  onSubmit: (value: string | null) => void;
  submitted: boolean = false;
  inputEl: HTMLInputElement;

  constructor(app: App, defaultValue: string, onSubmit: (value: string | null) => void) {
    super(app);
    this.defaultValue = defaultValue;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('kanban-plugin__new-card-modal');

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
    this.onSubmit(this.inputEl.value);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.submitted) {
      this.onSubmit(null);
    }
  }
}

function promptCardName(app: App, defaultValue: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new NewCardModal(app, defaultValue, (value) => resolve(value));
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
    const name = await promptCardName(stateManager.app, defaultName);
    if (name === null) return;

    const trimmedName = name.trim();
    const sanitizedName = sanitizeName(trimmedName);

    if (!sanitizedName) return;

    const vault = stateManager.app.vault;
    const listFolderPath = getListFolderPath(stateManager.file, listTitle);
    await ensureFolder(vault, listFolderPath);

    const cardFileName = buildCardFilename(trimmedName, new Date());
    const cardFilePath = `${listFolderPath}/${cardFileName}`;
    if (vault.getAbstractFileByPath(cardFilePath)) {
      new Notice(`Card "${trimmedName}" already exists in this list.`);
      return;
    }

    await vault.create(cardFilePath, '');
    const descriptionBody = description.trim();
    if (descriptionBody && descriptionBody !== trimmedName) {
      const cardFile = vault.getAbstractFileByPath(cardFilePath);
      if (cardFile && cardFile instanceof TFile) {
        await vault.modify(cardFile, descriptionBody);
      }
    }
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
      .catch((e) => console.error(e))
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
