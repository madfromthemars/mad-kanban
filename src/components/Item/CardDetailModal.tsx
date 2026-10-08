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
import { moveEntity } from 'src/dnd/util/data';
import { setPriorityInTitle } from 'src/kanbanFileHelpers';
import {
  joinCardBody,
  normalizeTag,
  removeTagTokens,
  setDueInTitle,
  splitCardBody,
  splitFrontmatter,
  tagsIn,
} from 'src/cardTasks';
import { Checklist, DuePicker, TagEditor } from './CardChecklist';
import { PRIORITY_LEVELS, PriorityIcon } from './PriorityIcon';
import { AttachButton, TeamComments } from 'src/team/ui/CardPanel';
import { parseTeamItemId } from 'src/team/ids';

import { MarkdownEditor, allowNewLine } from '../Editor/MarkdownEditor';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import { KanbanContext } from '../context';
import { c } from '../helpers';
import { EditingState, Item, isEditing, EditState } from '../types';
import { InlineMetadata } from './InlineMetadata';
import { cardBodyCache, getCardCacheKey } from './ItemContent';

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

const PRIORITIES = PRIORITY_LEVELS;

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div className={c('cd-field')}>
      <div className={c('cd-field-label')}>{label}</div>
      <div className={c('cd-field-value')}>{children}</div>
    </div>
  );
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
  const saveDescriptionRef = useRef<((description: string) => void) | null>(null);
  const [externalBody, setExternalBody] = useState<string | null>(null);
  const [cardFilePath, setCardFilePath] = useState<string>('');
  const [currentItem, setCurrentItem] = useState(item);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const board = stateManager.useState();

  // Keep showing the latest version of this card (server syncs, edits from the board).
  useEffect(() => {
    for (const lane of board?.children || []) {
      const found = lane.children.find((it) => it.id === currentItem.id);
      if (found) {
        if (found !== currentItem) setCurrentItem(found);
        return;
      }
    }
  }, [board]);

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

  const laneIndex = useMemo(() => {
    const lanes = board?.children || [];
    const i = lanes.findIndex((l) => l.children.some((it) => it.id === currentItem.id));
    return i >= 0 ? i : path[0];
  }, [board, currentItem.id, path]);

  const moveToLane = useCallback(
    (target: number) => {
      const from = resolvePath();
      if (from[0] === target) return;
      stateManager.setState((b) => moveEntity(b, from, [target, 0]));
    },
    [stateManager, resolvePath]
  );

  const setPriority = useCallback(
    (value: string | null) => {
      const p = resolvePath();
      const latest = stateManager.state?.children?.[p[0]]?.children?.[p[1]] || currentItem;
      const newItem = stateManager.updateItemContent(latest, setPriorityInTitle(latest.data.titleRaw, value));
      boardModifiers.updateItem(p, newItem);
      setCurrentItem(newItem);
      onItemUpdate?.(newItem);
    },
    [currentItem, stateManager, boardModifiers, resolvePath, onItemUpdate]
  );

  const setDue = useCallback(
    (iso: string | null) => {
      const p = resolvePath();
      const latest = stateManager.state?.children?.[p[0]]?.children?.[p[1]] || currentItem;
      // Always stored as YYYY-MM-DD so every board (and every teammate) reads it the same way.
      const trigger = stateManager.getSetting('date-trigger') || '@';
      const value = iso || null;
      const newItem = stateManager.updateItemContent(latest, setDueInTitle(latest.data.titleRaw, value, trigger));
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
        saveDescriptionRef.current?.(titleRef.current);
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

  // The card is edited as three separate parts: description, checklist and tags.
  // They live in the card's own note when it has one, otherwise in the card text.
  const sourceText = cardFilePath ? externalBody ?? '' : body;
  const { frontmatter, rest: bodyText } = splitFrontmatter(sourceText);
  const parts = splitCardBody(bodyText);

  const writeCard = (nextBody: string, mapFirstLine?: (first: string) => string) => {
    if (cardFilePath) {
      const target = stateManager.app.vault.getAbstractFileByPath(cardFilePath);
      const full = frontmatter + nextBody;
      if (target && target instanceof TFile) {
        void stateManager.app.vault.modify(target, full);
        setExternalBody(full);
        if (cacheKey) cardBodyCache.set(cacheKey, full);
      }
      if (!mapFirstLine) return;
    }
    const p = resolvePath();
    const latest = stateManager.state?.children?.[p[0]]?.children?.[p[1]] || currentItem;
    const split = splitTitleAndBody(latest.data.titleRaw);
    const first = mapFirstLine ? mapFirstLine(split.titleLine) : split.titleLine;
    const newItem = stateManager.updateItemContent(
      latest,
      combineTitleAndBody(first, cardFilePath ? split.body : nextBody)
    );
    boardModifiers.updateItem(p, newItem);
    setCurrentItem(newItem);
    onItemUpdate?.(newItem);
  };

  // Tags or checklist lines typed into the description go to their own sections.
  const saveDescription = (description: string) => {
    const typed = splitCardBody(description);
    const tags = [...parts.tags];
    for (const t of typed.tags) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    writeCard(
      joinCardBody({ description: typed.description, tasks: [...parts.tasks, ...typed.tasks], tags })
    );
  };
  saveDescriptionRef.current = saveDescription;

  const titleTags = tagsIn(splitTitleAndBody(currentItem.data.titleRaw).titleLine).filter(
    (t) => !parts.tags.some((x) => x.toLowerCase() === t.toLowerCase())
  );
  const allTags = [...parts.tags, ...titleTags];

  const addTags = (input: string) => {
    const fresh = input
      .split(/[\s,]+/)
      .map(normalizeTag)
      .filter((t) => t && !allTags.some((x) => x.toLowerCase() === t.toLowerCase()));
    if (fresh.length) writeCard(joinCardBody({ ...parts, tags: [...parts.tags, ...fresh] }));
  };

  const removeTag = (tag: string) => {
    const inTitle = titleTags.some((t) => t.toLowerCase() === tag.toLowerCase());
    writeCard(
      joinCardBody({ ...parts, tags: parts.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()) }),
      inTitle ? (first) => removeTagTokens(first, tag).trim() : undefined
    );
  };

  const tagSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const lane of stateManager.state?.children || []) {
      for (const it of lane.children) for (const t of it.data.metadata.tags || []) set.add(normalizeTag(t));
    }
    for (const tc of (stateManager.getSetting('tag-colors') as { tagKey: string }[]) || []) {
      set.add(normalizeTag(tc.tagKey));
    }
    return [...set].filter(Boolean).sort();
  }, [stateManager.state]);

  const editorValue = useMemo(() => {
    const v = parts.description;
    // Give media-only (or media-last) descriptions an empty line to type on.
    const lastLine = v.trimEnd().split('\n').pop() || '';
    return /(!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]|<\/video>|<video\b[^>]*\/?>)\s*$/i.test(lastLine)
      ? `${v.trimEnd()}\n`
      : v;
  }, [parts.description]);

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

  // The cache only holds bodies of cards stored in their own note.
  const cachedBody = cacheKey && !isTeam && (cardFilePath || cardLinkPath) ? cardBodyCache.get(cacheKey) : undefined;
  const displayBody = externalBody ?? cachedBody ?? body;
  const contentToRender = displayBody ?? '';

  const lanes = board?.children || [];
  const priority = currentItem.data.metadata.priority;
  const currentPriority = priority && priority !== '3' ? priority : null;
  const team = stateManager.plugin?.team;
  const boardName = teamIds
    ? team?.boardNames.get(teamIds.boardId) || stateManager.file.basename
    : stateManager.file.basename;
  const descriptionMd = splitCardBody(splitFrontmatter(contentToRender).rest).description;
  const editing = isEditing(editState);

  return (
    <div className={c('card-detail-content')}>
      <div className={c('cd-header')}>
        <div className={c('cd-breadcrumb')}>
          <span>{boardName}</span>
          <span className={c('cd-breadcrumb-sep')}>›</span>
          <span>{lanes[laneIndex]?.data.title || laneTitle}</span>
          {isTeam && <span className={c('cd-team-pill')}>Team</span>}
        </div>
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
      </div>

      <div className={c('cd-layout')}>
        <div className={c('cd-main')}>
          <section className={c('cd-section')}>
            <div className={c('cd-section-head')}>
              <span className={c('cd-section-title')}>Description</span>
              {!editing && (
                <button
                  className={c('cd-ghost-button')}
                  onClick={(e) => {
                    e.preventDefault();
                    setEditState({ x: -1, y: -1 });
                  }}
                >
                  Edit
                </button>
              )}
              {editing && (
                <button
                  className={`${c('cd-ghost-button')} mod-cta`}
                  onClick={(e) => {
                    e.preventDefault();
                    setEditState(EditingState.complete);
                  }}
                >
                  Save
                </button>
              )}
            </div>

            {editing ? (
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
                <div className={c('cd-hint')}>Esc to cancel</div>
              </div>
            ) : (
              <div
                className={c('card-detail-body')}
                onDblClick={onDoubleClick}
                onClick={onImageClick}
                onPointerUp={onCheckboxContainerClick}
              >
                {descriptionMd ? (
                  <MarkdownRenderer
                    entityId={`modal-${currentItem.id}`}
                    className={c('item-markdown')}
                    markdownString={descriptionMd}
                  />
                ) : (
                  <div
                    className={c('card-detail-empty')}
                    onClick={() => setEditState({ x: -1, y: -1 })}
                  >
                    Add a description…
                  </div>
                )}
              </div>
            )}
          </section>

          <section className={c('cd-section')}>
            <div className={c('cd-section-head')}>
              <span className={c('cd-section-title')}>Checklist</span>
            </div>
            <Checklist body={bodyText} onChange={(next) => writeCard(next)} />
          </section>

          {teamIds && (
            <section className={c('cd-section')}>
              <TeamComments boardId={teamIds.boardId} cardId={teamIds.cardId} />
            </section>
          )}
        </div>

        <aside className={c('cd-sidebar')}>
          {lanes.length > 0 && (
            <Field label="Status">
              <select
                className={`dropdown ${c('cd-select')}`}
                value={String(laneIndex)}
                onChange={(e) => moveToLane(parseInt((e.target as HTMLSelectElement).value, 10))}
              >
                {lanes.map((l, i) => (
                  <option key={l.id} value={String(i)}>
                    {l.data.title}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Priority">
            <div className={c('cd-priority')}>
              {PRIORITIES.map((p) => (
                <button
                  key={p.label}
                  className={currentPriority === p.value ? 'is-active' : ''}
                  aria-label={p.label}
                  title={p.label}
                  onClick={() => setPriority(p.value)}
                >
                  <PriorityIcon value={p.value} />
                </button>
              ))}
            </div>
          </Field>

          <Field label="Due date">
            <DuePicker date={currentItem.data.metadata.date} onChange={setDue} />
          </Field>

          {isTeam && (
            <Field label="Assignees">
              <TeamCardExtras item={currentItem} detail={true} />
            </Field>
          )}

          <Field label="Tags">
            <TagEditor tags={allTags} suggestions={tagSuggestions} onAdd={addTags} onRemove={removeTag} />
          </Field>

          {currentItem.data.metadata.inlineMetadata?.length > 0 && (
            <Field label="Details">
              <div className={c('card-detail-metadata')}>
                <InlineMetadata item={currentItem} stateManager={stateManager} />
              </div>
            </Field>
          )}

          {teamIds && (
            <Field label="Attachments">
              <AttachButton boardId={teamIds.boardId} onUploaded={appendToCard} label="Add image or video" />
            </Field>
          )}

          {cardFilePath && (
            <Field label="Note">
              <a
                className={c('cd-link')}
                onClick={() => void stateManager.app.workspace.openLinkText(cardFilePath, '', 'tab')}
              >
                {cardFilePath.split('/').pop()}
              </a>
            </Field>
          )}
        </aside>
      </div>

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
    this.modalEl.addClass('kanban-plugin__card-detail-window');

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
    // Free the description preview this window cached on the board view.
    const key = `modal-${this.item.id}`;
    const preview = this.view?.previewCache?.get(key);
    if (preview) {
      this.view.removeChild(preview);
      this.view.previewCache.delete(key);
    }
  }
}
