import { App, Modal, TFile } from 'obsidian';
import { render } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { EditorView } from '@codemirror/view';
import { StateManager } from 'src/StateManager';
import { BoardModifiers } from 'src/helpers/boardModifiers';
import { Path } from 'src/dnd/types';
import {
  extractCardTitle,
  extractCardLinkPath,
  findCardFilePathInListFile,
  findCardFilePathInListFolder,
  findCardFileInVault,
  getListFilePath,
  getListFolderPath,
} from 'src/kanbanFileHelpers';
import { getTaskStatusDone, toggleTaskString } from 'src/parsers/helpers/inlineMetadata';
import { isTeamItem } from 'src/team/ids';
import { TeamCardExtras } from 'src/team/ui/TeamBadges';
import { AttachButton, TeamComments } from 'src/team/ui/CardPanel';
import { parseTeamItemId } from 'src/team/ids';

import { MarkdownEditor, allowNewLine } from '../Editor/MarkdownEditor';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import { KanbanContext } from '../context';
import { c } from '../helpers';
import { EditingState, Item, isEditing, EditState } from '../types';
import { InlineMetadata } from './InlineMetadata';
import { Tags, cardBodyCache, getCardCacheKey } from './ItemContent';

function checkCheckbox(stateManager: StateManager, title: string, checkboxIndex: number) {
  let count = 0;
  const lines = title.split(/\n\r?/g);
  const results: string[] = [];

  lines.forEach((line) => {
    if (count > checkboxIndex) {
      results.push(line);
      return;
    }

    const match = line.match(/^(\s*>)*(\s*[-+*]\s+?\[)([^\]])(\]\s+)/);

    if (match) {
      if (count === checkboxIndex) {
        const updates = toggleTaskString(line, stateManager.file);
        if (updates) {
          results.push(updates);
        } else {
          const check = match[3] === ' ' ? getTaskStatusDone() : ' ';
          const m1 = match[1] ?? '';
          const m2 = match[2] ?? '';
          const m4 = match[4] ?? '';
          results.push(m1 + m2 + check + m4 + line.slice(match[0].length));
        }
      } else {
        results.push(line);
      }
      count++;
      return;
    }

    results.push(line);
  });

  return results.join('\n');
}

function splitTitleAndBody(titleRaw: string) {
  const lines = titleRaw.split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  return {
    titleLine: first,
    body: lines.slice(1).join('\n').trim(),
  };
}

function combineTitleAndBody(titleLine: string, body: string) {
  if (!body.trim()) return titleLine.trim();
  return `${titleLine.trim()}\n${body.trim()}`;
}

interface CardDetailContentProps {
  item: Item;
  path: Path;
  onItemUpdate?: (item: Item) => void;
}

const CardDetailContent = memo(function CardDetailContent({
  item,
  path,
  onItemUpdate,
}: CardDetailContentProps) {
  const { stateManager, filePath, boardModifiers } = useContext(KanbanContext);
  const [editState, setEditState] = useState<EditState>(EditingState.cancel);
  const titleRef = useRef<string | null>(null);
  const [externalBody, setExternalBody] = useState<string | null>(null);
  const [cardFilePath, setCardFilePath] = useState<string>('');
  const [currentItem, setCurrentItem] = useState(item);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const isTeam = isTeamItem(currentItem);
  const teamIds = isTeam ? parseTeamItemId(currentItem.id) : null;

  // Team boards reload from the server while the modal is open, so the card's
  // index can shift; always look it up by id before writing.
  const resolvePath = useCallback((): Path => {
    const board = stateManager.state;
    if (board) {
      for (let l = 0; l < board.children.length; l++) {
        const i = board.children[l].children.findIndex((it) => it.id === currentItem.id);
        if (i >= 0) return [l, i];
      }
    }
    return path;
  }, [stateManager, currentItem.id, path]);

  const appendToCard = useCallback(
    (md: string) => {
      const latest = (() => {
        const p = resolvePath();
        return stateManager.state?.children?.[p[0]]?.children?.[p[1]] || currentItem;
      })();
      const raw = latest.data.titleRaw.replace(/\s+$/, '');
      const newItem = stateManager.updateItemContent(latest, `${raw}\n${md}`);
      boardModifiers.updateItem(resolvePath(), newItem);
      setCurrentItem(newItem);
      onItemUpdate?.(newItem);
    },
    [currentItem, stateManager, boardModifiers, resolvePath, onItemUpdate]
  );

  const renameCard = useCallback(
    (newTitle: string) => {
      const trimmed = newTitle.trim();
      setIsRenaming(false);
      if (!trimmed) return;
      const oldTitle = extractCardTitle(currentItem.data.titleRaw);
      if (trimmed === oldTitle) return;
      const lines = currentItem.data.titleRaw.split(/\r?\n/);
      lines[0] = oldTitle && lines[0].includes(oldTitle) ? lines[0].replace(oldTitle, trimmed) : trimmed;
      const newItem = stateManager.updateItemContent(currentItem, lines.join('\n'));
      boardModifiers.updateItem(resolvePath(), newItem);
      setCurrentItem(newItem);
      onItemUpdate?.(newItem);
    },
    [currentItem, stateManager, boardModifiers, resolvePath, onItemUpdate]
  );

  const { titleLine, body } = useMemo(
    () => splitTitleAndBody(currentItem.data.titleRaw),
    [currentItem.data.titleRaw]
  );
  const cardTitle = useMemo(() => extractCardTitle(currentItem.data.titleRaw), [currentItem.data.titleRaw]);
  const cardLinkPath = useMemo(() => extractCardLinkPath(currentItem.data.titleRaw), [currentItem.data.titleRaw]);
  const cacheKey = useMemo(
    () => {
      const key = cardLinkPath || cardTitle;
      return key ? getCardCacheKey(stateManager.file.path, key) : '';
    },
    [stateManager.file.path, cardLinkPath, cardTitle]
  );

  // Resolve card file path
  const laneTitle = useMemo(
    () => stateManager.state?.children?.[path[0]]?.data?.title || '',
    [stateManager.state, path]
  );

  useEffect(() => {
    let cancelled = false;

    if (isTeam) {
      setCardFilePath('');
      return;
    }

    if (cardLinkPath) {
      const file = stateManager.app.vault.getAbstractFileByPath(cardLinkPath);
      if (file && file instanceof TFile) {
        setCardFilePath(cardLinkPath);
        return;
      }
      const altPath = cardLinkPath.endsWith('.md') ? cardLinkPath.slice(0, -3) : `${cardLinkPath}.md`;
      const altFile = stateManager.app.vault.getAbstractFileByPath(altPath);
      if (altFile && altFile instanceof TFile) {
        setCardFilePath(altPath);
        return;
      }
    }

    if (!cardTitle) return;

    const listFileP = getListFilePath(stateManager.file, laneTitle);
    const listFolderP = getListFolderPath(stateManager.file, laneTitle);

    const findFile = async () => {
      let foundPath = await findCardFilePathInListFile(stateManager.app, listFileP, cardTitle);

      if (foundPath && !stateManager.app.vault.getAbstractFileByPath(foundPath)) {
        foundPath = null;
      }

      if (!foundPath) {
        foundPath = await findCardFilePathInListFolder(stateManager.app, listFolderP, cardTitle);
      }

      if (!foundPath) {
        foundPath = findCardFileInVault(stateManager.app, cardTitle);
      }

      if (cancelled) return;

      if (foundPath) {
        setCardFilePath(foundPath);
      }
    };

    void findFile();

    return () => { cancelled = true; };
  }, [cardLinkPath, cardTitle, laneTitle, stateManager.app, stateManager.file]);

  // Load external file content
  useEffect(() => {
    let cancelled = false;
    if (!cardFilePath) return;

    const file = stateManager.app.vault.getAbstractFileByPath(cardFilePath);
    if (!(file && file instanceof TFile)) return;

    void stateManager.app.vault.read(file).then((content) => {
      if (cancelled) return;
      setExternalBody(content);
      if (cacheKey) {
        cardBodyCache.set(cacheKey, content);
      }
    });

    return () => { cancelled = true; };
  }, [cardFilePath, stateManager.app.vault]);

  // Handle edit state changes
  useEffect(() => {
    if (editState === EditingState.complete) {
      if (titleRef.current !== null) {
        const updatedBody = titleRef.current;
        if (cardFilePath) {
          const target = stateManager.app.vault.getAbstractFileByPath(cardFilePath);
          if (target && target instanceof TFile) {
            void stateManager.app.vault.modify(target, updatedBody);
            setExternalBody(updatedBody);
            if (cacheKey) {
              cardBodyCache.set(cacheKey, updatedBody);
            }
          }
        } else {
          const updated = combineTitleAndBody(titleLine, updatedBody);
          const newItem = stateManager.updateItemContent(currentItem, updated);
          boardModifiers.updateItem(resolvePath(), newItem);
          setCurrentItem(newItem);
          onItemUpdate?.(newItem);
        }
      }
      titleRef.current = null;
    } else if (editState === EditingState.cancel) {
      titleRef.current = null;
    }
  }, [editState]);

  const onEnter = useCallback(
    (cm: EditorView, mod: boolean, shift: boolean) => {
      if (!allowNewLine(stateManager, mod, shift)) {
        setEditState(EditingState.complete);
        return true;
      }
    },
    [stateManager]
  );

  const onSubmit = useCallback(() => setEditState(EditingState.complete), []);
  const onEscape = useCallback(() => {
    setEditState(EditingState.cancel);
    return true;
  }, []);

  const onCheckboxContainerClick = useCallback(
    (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.hasClass('task-list-item-checkbox')) {
        if (target.dataset.src) return;

        const checkboxIndex = parseInt(target.dataset.checkboxIndex, 10);

        if (cardFilePath && externalBody) {
          const updated = checkCheckbox(stateManager, externalBody, checkboxIndex);
          const file = stateManager.app.vault.getAbstractFileByPath(cardFilePath);
          if (file && file instanceof TFile) {
            void stateManager.app.vault.modify(file, updated);
            setExternalBody(updated);
            if (cacheKey) {
              cardBodyCache.set(cacheKey, updated);
            }
          }
        } else {
          const checked = checkCheckbox(stateManager, currentItem.data.titleRaw, checkboxIndex);
          const newItem = stateManager.updateItemContent(currentItem, checked);
          boardModifiers.updateItem(resolvePath(), newItem);
          setCurrentItem(newItem);
          onItemUpdate?.(newItem);
        }
      }
    },
    [path, boardModifiers, stateManager, currentItem, cardFilePath, externalBody, cacheKey]
  );

  const imageClickTimer = useRef<number | null>(null);

  const onDoubleClick = useCallback(
    (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.hasClass('task-list-item-checkbox')) return;
      if (target.closest('a') && !target.instanceOf(HTMLImageElement)) return;
      if (target.instanceOf(HTMLImageElement) || target.closest('video')) {
        // Media fills the line, so there is no text position under the pointer.
        if (imageClickTimer.current != null) window.clearTimeout(imageClickTimer.current);
        imageClickTimer.current = null;
        setLightboxSrc(null);
        setEditState({ x: -1, y: -1 });
        return;
      }
      setEditState({ x: e.clientX, y: e.clientY });
    },
    []
  );

  const onImageClick = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.instanceOf(HTMLImageElement)) {
      e.preventDefault();
      e.stopPropagation();
      const src = (target as HTMLImageElement).src;
      // Wait briefly so a double-click (edit) doesn't also open the preview.
      if (imageClickTimer.current != null) window.clearTimeout(imageClickTimer.current);
      imageClickTimer.current = window.setTimeout(() => {
        imageClickTimer.current = null;
        setLightboxSrc(src);
      }, 250);
    }
  }, []);

  const editorValue = useMemo(() => {
    const v = externalBody ?? body;
    // Give media-only (or media-last) descriptions an empty line to type on.
    const lastLine = v.trimEnd().split('\n').pop() || '';
    return /(!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]|<\/video>|<video\b[^>]*\/?>)\s*$/i.test(lastLine)
      ? `${v.trimEnd()}\n`
      : v;
  }, [externalBody, body]);

  useEffect(() => {
    if (!lightboxSrc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setLightboxSrc(null);
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [lightboxSrc]);

  const cachedBody = cacheKey ? cardBodyCache.get(cacheKey) : undefined;
  const displayBody = externalBody ?? cachedBody ?? body;
  const contentToRender = displayBody ?? '';

  return (
    <div className={c('card-detail-content')}>
      <div className={c('card-detail-title')}>
        {isTeam && isRenaming ? (
          <input
            type="text"
            className={c('card-detail-title-input')}
            defaultValue={cardTitle || titleLine}
            ref={(el) => {
              if (el) setTimeout(() => el.focus(), 0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                renameCard((e.target as HTMLInputElement).value);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setIsRenaming(false);
              }
            }}
            onBlur={(e) => renameCard((e.target as HTMLInputElement).value)}
          />
        ) : (
          <h2
            className={isTeam ? c('card-detail-title-editable') : undefined}
            title={isTeam ? 'Click to rename' : undefined}
            onClick={isTeam ? () => setIsRenaming(true) : undefined}
          >
            {cardTitle || titleLine}
          </h2>
        )}
      </div>
      {isTeam && (
        <div className={c('card-detail-team')}>
          <TeamCardExtras item={currentItem} detail={true} />
          {teamIds && (
            <AttachButton boardId={teamIds.boardId} onUploaded={appendToCard} label="Attach image / video" />
          )}
        </div>
      )}

      {!isEditing(editState) && (
        <div className={c('card-detail-actions')}>
          <button
            className={c('card-detail-edit-button')}
            onClick={(e) => {
              e.preventDefault();
              setEditState({ x: -1, y: -1 });
            }}
          >
            ✏️ Edit description
          </button>
        </div>
      )}

      {isEditing(editState) ? (
        <div className={c('card-detail-editor')}>
          <MarkdownEditor
            editState={editState}
            className={c('item-input')}
            onEnter={onEnter}
            onEscape={onEscape}
            onSubmit={onSubmit}
            value={editorValue}
            onChange={(update) => {
              if (update.docChanged) {
                titleRef.current = update.state.doc.toString().trim();
              }
            }}
          />
        </div>
      ) : (
        <div
          className={c('card-detail-body')}
          onDblClick={onDoubleClick}
          onClick={onImageClick}
          onPointerUp={onCheckboxContainerClick}
        >
          {contentToRender ? (
            <MarkdownRenderer
              entityId={`modal-${currentItem.id}`}
              className={c('item-markdown')}
              markdownString={contentToRender}
            />
          ) : (
            <div className={c('card-detail-empty')}>Double-click to add content</div>
          )}
        </div>
      )}

      <div className={c('card-detail-metadata')}>
        <InlineMetadata item={currentItem} stateManager={stateManager} />
        <Tags tags={currentItem.data.metadata.tags} alwaysShow={true} />
      </div>

      {teamIds && <TeamComments boardId={teamIds.boardId} cardId={teamIds.cardId} />}

      {lightboxSrc && (
        <div
          className={c('image-lightbox')}
          onClick={() => setLightboxSrc(null)}
        >
          <img src={lightboxSrc} />
        </div>
      )}
    </div>
  );
});

export class CardDetailModal extends Modal {
  private item: Item;
  private stateManager: StateManager;
  private boardModifiers: BoardModifiers;
  private path: Path;
  private view: any;
  private kanbanContext: any;

  constructor(
    app: App,
    item: Item,
    stateManager: StateManager,
    boardModifiers: BoardModifiers,
    path: Path,
    view: any,
    kanbanContext: any,
  ) {
    super(app);
    this.item = item;
    this.stateManager = stateManager;
    this.boardModifiers = boardModifiers;
    this.path = path;
    this.view = view;
    this.kanbanContext = kanbanContext;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('kanban-plugin__card-detail-modal');

    render(
      <KanbanContext.Provider value={this.kanbanContext}>
        <CardDetailContent
          item={this.item}
          path={this.path}
        />
      </KanbanContext.Provider>,
      contentEl
    );
  }

  onClose() {
    render(null, this.contentEl);
    this.contentEl.empty();
  }
}
