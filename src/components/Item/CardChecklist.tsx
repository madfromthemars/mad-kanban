import { moment } from 'obsidian';
import { useContext, useRef, useState } from 'preact/compat';
import { addTask, deleteTask, editTask, moveTask, parseTasks, toggleTask } from 'src/cardTasks';

import { KanbanContext } from '../context';
import { Icon } from '../Icon/Icon';
import { saveMediaToVault } from 'src/team/ui/CardPanel';
import { c, useGetTagColorFn } from '../helpers';

/** Interactive checklist built from the `- [ ]` lines of a card body. */
export function Checklist({
  body,
  onChange,
  compact,
}: {
  body: string;
  onChange: (body: string) => void;
  compact?: boolean;
}) {
  const tasks = parseTasks(body);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  // Enter and the blur that follows it must only save once.
  const committedRef = useRef(false);

  const startEdit = (i: number) => {
    committedRef.current = false;
    setEditing(i);
  };

  const commitEdit = (task: { line: number; text: string }, value: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    setEditing(null);
    const text = value.trim();
    if (!text) onChange(deleteTask(body, task.line));
    else if (text !== task.text) onChange(editTask(body, task.line, text));
  };

  const done = tasks.filter((t) => t.checked).length;
  const percent = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  const commitAdd = () => {
    const text = draft.trim();
    if (!text) {
      setAdding(false);
      return;
    }
    onChange(addTask(body, text));
    setDraft('');
    // keep the input open for the next item
    setTimeout(() => addRef.current?.focus(), 0);
  };

  return (
    <div className={`${c('checklist')} ${compact ? 'is-compact' : ''}`} data-ignore-drag={true}>
      {tasks.length > 0 && (
        <div className={c('checklist-progress')}>
          <span className={c('checklist-percent')}>{percent}%</span>
          <div className={c('checklist-bar')}>
            <div
              className={`${c('checklist-bar-fill')} ${percent === 100 ? 'is-complete' : ''}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className={c('checklist-count')}>
            {done}/{tasks.length}
          </span>
        </div>
      )}

      <div className={c('checklist-items')}>
        {tasks.map((task, i) => (
          <div
            key={`${task.line}:${task.text}`}
            className={`${c('checklist-item')} ${task.checked ? 'is-checked' : ''} ${
              dragFrom !== null && dragFrom !== i ? 'is-drop-target' : ''
            }`}
            draggable={!compact && editing === null}
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer?.setData('text/plain', String(i));
            }}
            onDragEnd={() => setDragFrom(null)}
            onDragOver={(e) => {
              if (dragFrom !== null) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null && dragFrom !== i) onChange(moveTask(body, dragFrom, i));
              setDragFrom(null);
            }}
          >
            <input
              type="checkbox"
              className="task-list-item-checkbox"
              checked={task.checked}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onChange(toggleTask(body, task.line, (e.target as HTMLInputElement).checked))}
            />
            {editing === i ? (
              <input
                type="text"
                className={c('checklist-edit')}
                defaultValue={task.text}
                ref={(el) => {
                  if (el) setTimeout(() => el.focus(), 0);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitEdit(task, (e.target as HTMLInputElement).value);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    committedRef.current = true;
                    setEditing(null);
                  }
                }}
                onBlur={(e) => commitEdit(task, (e.target as HTMLInputElement).value)}
              />
            ) : (
              <span
                className={c('checklist-text')}
                title={compact ? undefined : 'Click to edit'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (compact) onChange(toggleTask(body, task.line, !task.checked));
                  else startEdit(i);
                }}
              >
                {task.text}
              </span>
            )}
            {!compact && (
              <button
                className={`${c('checklist-delete')} clickable-icon`}
                aria-label="Delete item"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(deleteTask(body, task.line));
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      {adding ? (
        <div className={c('checklist-add-row')}>
          <input
            ref={addRef}
            type="text"
            className={c('checklist-add-input')}
            placeholder="New item — Enter to add, Esc to close"
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commitAdd();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={() => {
              if (draft.trim()) commitAdd();
              else setAdding(false);
            }}
          />
        </div>
      ) : (
        <button
          className={c('checklist-add')}
          onClick={(e) => {
            e.stopPropagation();
            setAdding(true);
            setTimeout(() => addRef.current?.focus(), 0);
          }}
        >
          + Add item
        </button>
      )}
    </div>
  );
}

// ---------- due dates ----------

export type DueState = 'overdue' | 'today' | 'tomorrow' | 'soon' | 'later';

export function dueInfo(date: moment.Moment) {
  const today = moment().startOf('day');
  const d = date.clone().startOf('day');
  const days = d.diff(today, 'days');
  let state: DueState = 'later';
  let label = d.year() === today.year() ? d.format('MMM D') : d.format('MMM D, YYYY');
  if (days < 0) {
    state = 'overdue';
    label = days === -1 ? 'Yesterday' : label;
  } else if (days === 0) {
    state = 'today';
    label = 'Today';
  } else if (days === 1) {
    state = 'tomorrow';
    label = 'Tomorrow';
  } else if (days <= 3) {
    state = 'soon';
  }
  let relative = '';
  if (days < 0) relative = `${-days} day${days === -1 ? '' : 's'} overdue`;
  else if (days > 1) relative = `in ${days} days`;
  return { state, label, relative, days };
}

export function DueChip({ date, done }: { date: moment.Moment; done?: boolean }) {
  const info = dueInfo(date);
  return (
    <span
      className={`${c('due-chip')} is-${done ? 'done' : info.state}`}
      title={`Due ${date.format('dddd, MMM D, YYYY')}${info.relative ? ` (${info.relative})` : ''}`}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
      {info.label}
    </span>
  );
}

/** Date input with quick picks, for the card window. */
export function DuePicker({
  date,
  onChange,
}: {
  date: moment.Moment | undefined;
  onChange: (iso: string | null) => void;
}) {
  const iso = date?.isValid() ? date.format('YYYY-MM-DD') : '';
  const info = date?.isValid() ? dueInfo(date) : null;
  const quick: { label: string; value: () => string }[] = [
    { label: 'Today', value: () => moment().format('YYYY-MM-DD') },
    { label: 'Tomorrow', value: () => moment().add(1, 'day').format('YYYY-MM-DD') },
    { label: 'Next week', value: () => moment().add(1, 'week').startOf('isoWeek').format('YYYY-MM-DD') },
  ];
  return (
    <div className={c('due-picker')}>
      <div className={c('due-picker-row')}>
        <input
          type="date"
          className={`${c('due-input')} ${info ? `is-${info.state}` : ''}`}
          value={iso}
          onChange={(e) => onChange((e.target as HTMLInputElement).value || null)}
        />
        {iso && (
          <button className={`${c('due-clear')} clickable-icon`} aria-label="Remove due date" onClick={() => onChange(null)}>
            ×
          </button>
        )}
      </div>
      {info && (
        <div className={`${c('due-relative')} is-${info.state}`}>
          {info.state === 'overdue' ? info.relative : info.state === 'today' ? 'Due today' : info.state === 'tomorrow' ? 'Due tomorrow' : info.relative}
        </div>
      )}
      <div className={c('due-quick')}>
        {quick.map((q) => (
          <button key={q.label} onClick={() => onChange(q.value())}>
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- tags ----------

/** Tag chips with remove buttons and an input (with suggestions) to add more. */
export function TagEditor({
  tags,
  suggestions,
  onAdd,
  onRemove,
}: {
  tags: string[];
  suggestions: string[];
  onAdd: (input: string) => void;
  onRemove: (tag: string) => void;
}) {
  const { stateManager } = useContext(KanbanContext);
  const getTagColor = useGetTagColorFn(stateManager);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const listId = useRef(`kb-tags-${Math.random().toString(36).slice(2)}`).current;
  const lower = new Set(tags.map((t) => t.toLowerCase()));
  const options = suggestions.filter((s) => !lower.has(s.toLowerCase()));

  const commit = (value: string) => {
    if (value.trim()) onAdd(value);
    setDraft('');
  };

  return (
    <div className={c('tag-editor')}>
      {tags.map((tag) => {
        const color = getTagColor(`#${tag}`);
        return (
          <span
            key={tag}
            className={`tag ${c('tag-chip')}`}
            style={color ? { '--tag-color': color.color, '--tag-background': color.backgroundColor } : undefined}
          >
            #{tag}
            <button className={c('tag-chip-remove')} aria-label={`Remove #${tag}`} onClick={() => onRemove(tag)}>
              ×
            </button>
          </span>
        );
      })}
      {adding ? (
        <>
          <input
            type="text"
            className={c('tag-input')}
            list={listId}
            placeholder="tag name"
            value={draft}
            ref={(el) => {
              if (el) setTimeout(() => el.focus(), 0);
            }}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commit((e.target as HTMLInputElement).value);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={(e) => {
              commit((e.target as HTMLInputElement).value);
              setAdding(false);
            }}
          />
          <datalist id={listId}>
            {options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </>
      ) : (
        <button className={c('tag-add')} onClick={() => setAdding(true)}>
          + Tag
        </button>
      )}
    </div>
  );
}

/** "Add image or video" for personal cards: saves the file into the vault and embeds it. */
export function LocalAttachButton({ sourcePath, onSaved }: { sourcePath: string; onSaved: (md: string) => void }) {
  const { stateManager } = useContext(KanbanContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={{ display: 'none' }}
        onChange={async (e) => {
          const files = Array.from((e.target as HTMLInputElement).files || []);
          if (!files.length) return;
          setBusy(true);
          const md = await saveMediaToVault(stateManager.app, sourcePath, files);
          setBusy(false);
          if (inputRef.current) inputRef.current.value = '';
          if (md.length) onSaved(md.join('\n'));
        }}
      />
      <button className={c('attach-button')} disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? (
          'Saving…'
        ) : (
          <>
            <Icon name="lucide-paperclip" />
            Add image or video
          </>
        )}
      </button>
    </>
  );
}
