import { EditorView } from '@codemirror/view';
import { memo } from 'preact/compat';
import {
  Dispatch,
  StateUpdater,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';
import { StateManager } from 'src/StateManager';
import { TFile } from 'obsidian';
import { useNestedEntityPath } from 'src/dnd/components/Droppable';
import { Path } from 'src/dnd/types';
import { getTaskStatusDone, toggleTaskString } from 'src/parsers/helpers/inlineMetadata';
import {
  extractCardTitle,
  findCardFilePathInListFile,
  findCardFilePathInListFolder,
  getListFilePath,
  getListFolderPath,
} from 'src/kanbanFileHelpers';

import { MarkdownEditor, allowNewLine } from '../Editor/MarkdownEditor';
import {
  MarkdownClonedPreviewRenderer,
  MarkdownRenderer,
} from '../MarkdownRenderer/MarkdownRenderer';
import { KanbanContext, SearchContext } from '../context';
import { c, useGetDateColorFn, useGetTagColorFn } from '../helpers';
import { EditState, EditingState, Item, isEditing } from '../types';
import { DateAndTime, RelativeDate } from './DateAndTime';
import { InlineMetadata } from './InlineMetadata';
import {
  constructDatePicker,
  constructMenuDatePickerOnChange,
  constructMenuTimePickerOnChange,
  constructTimePicker,
} from './helpers';

const cardBodyCache = new Map<string, string>();

function getCardCacheKey(boardPath: string, cardTitle: string) {
  return `${boardPath}::${cardTitle}`;
}

export function useDatePickers(item: Item, explicitPath?: Path) {
  const { stateManager, boardModifiers } = useContext(KanbanContext);
  const path = explicitPath || useNestedEntityPath();

  return useMemo(() => {
    const onEditDate = (e: MouseEvent) => {
      constructDatePicker(
        e.view,
        stateManager,
        { x: e.clientX, y: e.clientY },
        constructMenuDatePickerOnChange({
          stateManager,
          boardModifiers,
          item,
          hasDate: true,
          path,
        }),
        item.data.metadata.date?.toDate()
      );
    };

    const onEditTime = (e: MouseEvent) => {
      constructTimePicker(
        e.view, // Preact uses real events, so this is safe
        stateManager,
        { x: e.clientX, y: e.clientY },
        constructMenuTimePickerOnChange({
          stateManager,
          boardModifiers,
          item,
          hasTime: true,
          path,
        }),
        item.data.metadata.time
      );
    };

    return {
      onEditDate,
      onEditTime,
    };
  }, [boardModifiers, path, item, stateManager]);
}

export interface ItemContentProps {
  item: Item;
  setEditState: Dispatch<StateUpdater<EditState>>;
  searchQuery?: string;
  showMetadata?: boolean;
  editState: EditState;
  isStatic: boolean;
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

export function Tags({
  tags,
  searchQuery,
  alwaysShow,
}: {
  tags?: string[];
  searchQuery?: string;
  alwaysShow?: boolean;
}) {
  const { stateManager } = useContext(KanbanContext);
  const getTagColor = useGetTagColorFn(stateManager);
  const search = useContext(SearchContext);
  const shouldShow = stateManager.useSetting('move-tags') || alwaysShow;

  if (!tags.length || !shouldShow) return null;

  return (
    <div className={c('item-tags')}>
      {tags.map((tag, i) => {
        const tagColor = getTagColor(tag);

        return (
          <a
            href={tag}
            onClick={(e) => {
              e.preventDefault();

              const tagAction = stateManager.getSetting('tag-action');
              if (search && tagAction === 'kanban') {
                search.search(tag, true);
                return;
              }

              (stateManager.app as any).internalPlugins
                .getPluginById('global-search')
                .instance.openGlobalSearch(`tag:${tag}`);
            }}
            key={i}
            className={`tag ${c('item-tag')} ${
              searchQuery && tag.toLocaleLowerCase().contains(searchQuery) ? 'is-search-match' : ''
            }`}
            style={
              tagColor && {
                '--tag-color': tagColor.color,
                '--tag-background': tagColor.backgroundColor,
              }
            }
          >
            <span>{tag[0]}</span>
            {tag.slice(1)}
          </a>
        );
      })}
    </div>
  );
}

export const ItemContent = memo(function ItemContent({
  item,
  editState,
  setEditState,
  searchQuery,
  showMetadata = true,
  isStatic,
}: ItemContentProps) {
  const { stateManager, filePath, boardModifiers } = useContext(KanbanContext);
  const getDateColor = useGetDateColorFn(stateManager);
  const titleRef = useRef<string | null>(null);
  const [externalBody, setExternalBody] = useState<string | null>(null);
  const { titleLine, body } = useMemo(
    () => splitTitleAndBody(item.data.titleRaw),
    [item.data.titleRaw]
  );
  const path = useNestedEntityPath();
  const cardTitle = useMemo(() => extractCardTitle(item.data.titleRaw), [item.data.titleRaw]);
  const cacheKey = useMemo(
    () => (cardTitle ? getCardCacheKey(stateManager.file.path, cardTitle) : ''),
    [stateManager.file.path, cardTitle]
  );
  const laneTitle = useMemo(
    () => stateManager.state?.children?.[path[0]]?.data?.title || '',
    [stateManager.state, path]
  );
  const [cardFilePath, setCardFilePath] = useState<string>('');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const lastCardFilePathRef = useRef<string>('');
  const lastExternalBodyRef = useRef<string>('');
  const lastLaneTitleRef = useRef<string>(laneTitle);

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
          boardModifiers.updateItem(path, stateManager.updateItemContent(item, updated));
        }
      }
      titleRef.current = null;
    } else if (editState === EditingState.cancel) {
      titleRef.current = null;
    }
  }, [editState, stateManager, item, cardFilePath, titleLine, boardModifiers, path]);

  const { onEditDate, onEditTime } = useDatePickers(item);
  const onEnter = useCallback(
    (cm: EditorView, mod: boolean, shift: boolean) => {
      if (!allowNewLine(stateManager, mod, shift)) {
        setEditState(EditingState.complete);
        return true;
      }
    },
    [stateManager]
  );

  const onWrapperClick = useCallback(
    (e: MouseEvent) => {
      if (e.targetNode.instanceOf(HTMLElement)) {
        if (e.targetNode.hasClass(c('item-metadata-date'))) {
          onEditDate(e);
        } else if (e.targetNode.hasClass(c('item-metadata-time'))) {
          onEditTime(e);
        }
      }
    },
    [onEditDate, onEditTime]
  );

  const onSubmit = useCallback(() => setEditState(EditingState.complete), []);

  const onEscape = useCallback(() => {
    setEditState(EditingState.cancel);
    return true;
  }, [item]);

  const onCheckboxContainerClick = useCallback(
    (e: PointerEvent) => {
      const target = e.target as HTMLElement;

      if (target.hasClass('task-list-item-checkbox')) {
        if (target.dataset.src) {
          return;
        }

        const checkboxIndex = parseInt(target.dataset.checkboxIndex, 10);
        const checked = checkCheckbox(stateManager, item.data.titleRaw, checkboxIndex);
        const updated = stateManager.updateItemContent(item, checked);

        boardModifiers.updateItem(path, updated);
      }
    },
    [path, boardModifiers, stateManager, item]
  );

  useEffect(() => {
    let cancelled = false;
    if (!laneTitle || !cardTitle) {
      setCardFilePath('');
      setExternalBody(null);
      setIsTransitioning(false);
      lastCardFilePathRef.current = '';
      lastExternalBodyRef.current = '';
      lastLaneTitleRef.current = '';
      return;
    }

    // Detect lane change - mark as transitioning to preserve content
    const laneChanged = lastLaneTitleRef.current && lastLaneTitleRef.current !== laneTitle;
    if (laneChanged) {
      setIsTransitioning(true);
    }
    lastLaneTitleRef.current = laneTitle;

    if (lastCardFilePathRef.current) {
      const basename = lastCardFilePathRef.current.split('/').pop() || '';
      if (basename) {
        const optimisticPath = `${getListFolderPath(stateManager.file, laneTitle)}/${basename}`;
        setCardFilePath(optimisticPath);
      }
    }

    const listFilePath = getListFilePath(stateManager.file, laneTitle);
    const listFolderPath = getListFolderPath(stateManager.file, laneTitle);

    const findFile = async () => {
      // Try to find in list file first
      let foundPath = await findCardFilePathInListFile(stateManager.app, listFilePath, cardTitle);

      // Fallback to folder search
      if (!foundPath) {
        foundPath = await findCardFilePathInListFolder(stateManager.app, listFolderPath, cardTitle);
      }

      // If still not found and transitioning, retry after a delay (file might still be moving)
      if (!foundPath && laneChanged) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        foundPath = await findCardFilePathInListFile(stateManager.app, listFilePath, cardTitle);
        if (!foundPath) {
          foundPath = await findCardFilePathInListFolder(stateManager.app, listFolderPath, cardTitle);
        }
      }

      if (cancelled) return;

      if (foundPath) {
        setCardFilePath(foundPath);
      }
      setIsTransitioning(false);
    };

    void findFile();

    return () => {
      cancelled = true;
    };
  }, [laneTitle, cardTitle, stateManager.app, stateManager.file]);

  useEffect(() => {
    let cancelled = false;
    if (!cardFilePath) {
      return;
    }

    const file = stateManager.app.vault.getAbstractFileByPath(cardFilePath);
    if (!(file && file instanceof TFile)) {
      return;
    }

    void stateManager.app.vault.read(file).then((content) => {
      if (cancelled) return;
      setExternalBody(content);
      lastExternalBodyRef.current = content;
      if (cacheKey) {
        cardBodyCache.set(cacheKey, content);
      }
    });

    lastCardFilePathRef.current = cardFilePath;

    return () => {
      cancelled = true;
    };
  }, [cardFilePath, stateManager.app.vault]);

  if (!isStatic && isEditing(editState)) {
    return (
      <div className={c('item-input-wrapper')}>
        <MarkdownEditor
          editState={editState}
          className={c('item-input')}
          onEnter={onEnter}
          onEscape={onEscape}
          onSubmit={onSubmit}
          value={externalBody ?? body}
          onChange={(update) => {
            if (update.docChanged) {
              titleRef.current = update.state.doc.toString().trim();
            }
          }}
        />
      </div>
    );
  }

  const cachedBody = cacheKey ? cardBodyCache.get(cacheKey) : undefined;
  // During transition, prefer the last known content to avoid flicker
  const transitionBody = isTransitioning ? lastExternalBodyRef.current : null;
  const displayBody = externalBody ?? transitionBody ?? cachedBody ?? body;
  // Always render content area - show displayBody if available, otherwise empty string
  const contentToRender = displayBody ?? '';
  const shouldShowContent = contentToRender || !titleLine;
  return (
    <div onClick={onWrapperClick} className={c('item-title')}>
      {shouldShowContent &&
        (isStatic ? (
          <MarkdownClonedPreviewRenderer
            entityId={item.id}
            className={c('item-markdown')}
            markdownString={contentToRender}
            searchQuery={searchQuery}
            onPointerUp={onCheckboxContainerClick}
          />
        ) : (
          <MarkdownRenderer
            entityId={item.id}
            className={c('item-markdown')}
            markdownString={contentToRender}
            searchQuery={searchQuery}
            onPointerUp={onCheckboxContainerClick}
          />
        ))}
      {showMetadata && (
        <div className={c('item-metadata')}>
          <RelativeDate item={item} stateManager={stateManager} />
          <DateAndTime
            item={item}
            stateManager={stateManager}
            filePath={filePath}
            getDateColor={getDateColor}
          />
          <InlineMetadata item={item} stateManager={stateManager} />
          <Tags tags={item.data.metadata.tags} searchQuery={searchQuery} />
        </div>
      )}
    </div>
  );
});
