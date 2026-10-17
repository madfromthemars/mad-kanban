import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/compat';
import { c } from 'src/components/helpers';
import { cardWindowEscape } from 'src/components/copyOnClick';

import type { TeamManager } from '../TeamManager';
import { TeamUser } from '../types';
import { hueFor, initials } from './TeamBadges';

/** The "@query" being typed right before the caret, or null. */
function activeQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/[\s([{"'«]/.test(before[at - 1])) return null; // e.g. an email address
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@]/.test(query)) return null;
  // Names can have one space ("Ann Lee"); two spaces in a row means the mention is over.
  if (/\s{2}|\s.*\s/.test(query)) return null;
  return { start: at, query };
}

function rank(users: TeamUser[], query: string, meId: string | undefined) {
  const q = query.toLowerCase();
  const scored = users
    .map((u) => {
      const name = u.name.toLowerCase();
      const score = name.startsWith(q) ? 0 : name.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : name.includes(q) ? 2 : -1;
      return { u, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || Number(a.u.id === meId) - Number(b.u.id === meId) || a.u.name.localeCompare(b.u.name));
  return scored.map((x) => x.u).slice(0, 6);
}

/**
 * "@" suggestions for a comment textarea: who can see the card, filtered as you type.
 * Returns props for the textarea and the popup to render next to it.
 */
export function useMentions({
  team,
  boardId,
  cardId,
  value,
  setValue,
  inputRef,
}: {
  team: TeamManager;
  boardId: string;
  cardId: string;
  value: string;
  setValue: (v: string) => void;
  inputRef: { current: HTMLTextAreaElement | null };
}) {
  const [people, setPeople] = useState<TeamUser[] | null>(null);
  const [state, setState] = useState<{ start: number; query: string } | null>(null);
  const [index, setIndex] = useState(0);
  const loading = useRef(false);

  const load = useCallback(() => {
    if (people || loading.current) return;
    loading.current = true;
    team.client
      .cardPeople(boardId, cardId)
      .then((u) => setPeople(u))
      // Older servers: fall back to everyone this person can see.
      .catch(() => setPeople(team.users))
      .finally(() => (loading.current = false));
  }, [people, team, boardId, cardId]);

  const matches = useMemo(
    () => (state && people ? rank(people, state.query, team.user?.id) : []),
    [state, people, team.user?.id]
  );
  const open = !!state && matches.length > 0;

  useEffect(() => setIndex(0), [state?.query]);

  // Esc closes the suggestions first, not the whole card window.
  useEffect(() => {
    if (!open) return;
    const handler = () => {
      setState(null);
      return true;
    };
    cardWindowEscape.push(handler);
    return () => {
      cardWindowEscape.remove(handler);
    };
  }, [open]);

  const update = () => {
    const el = inputRef.current;
    if (!el) return;
    const q = activeQuery(el.value, el.selectionStart ?? el.value.length);
    setState(q);
    if (q) load();
  };

  const pick = (u: TeamUser) => {
    const el = inputRef.current;
    if (!el || !state) return;
    const caret = el.selectionStart ?? value.length;
    const next = `${value.slice(0, state.start)}@${u.name} ${value.slice(caret)}`;
    const pos = state.start + u.name.length + 2;
    setValue(next);
    setState(null);
    window.setTimeout(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    }, 0);
  };

  /** Call first in the textarea's keydown; true means the key was used by the picker. */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pick(matches[index] || matches[0]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setState(null);
      return true;
    }
    return false;
  };

  const popup = open ? (
    <div className={c('mention-popup')} role="listbox">
      {matches.map((u, i) => (
        <div
          key={u.id}
          role="option"
          aria-selected={i === index}
          className={`${c('mention-option')} ${i === index ? 'is-selected' : ''}`}
          // mousedown, so the textarea keeps focus (and the phone keyboard stays up)
          onMouseDown={(e) => {
            e.preventDefault();
            pick(u);
          }}
          onMouseEnter={() => setIndex(i)}
        >
          <span className={c('assignee')} style={{ '--assignee-hue': hueFor(u.id) }}>
            {initials(u.name)}
          </span>
          <span className={c('mention-name')}>{u.name}</span>
          {u.id === team.user?.id && <span className={c('mention-me')}>you</span>}
        </div>
      ))}
    </div>
  ) : null;

  return {
    popup,
    onKeyDown,
    /** For onInput / onClick / onKeyUp of the textarea. */
    onCaret: update,
    close: () => setState(null),
  };
}

/**
 * Wrap "@Name" in a rendered comment in a highlight. Walks text nodes only, so links,
 * code and images are left alone. Longer names win ("@Ann Lee" over "@Ann").
 */
export function highlightMentions(el: HTMLElement, users: TeamUser[], meId: string | undefined) {
  const names = users.filter((u) => u.name).sort((a, b) => b.name.length - a.name.length);
  if (!names.length) return;
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue?.includes('@') && !(n.parentElement?.closest('code, pre, a, .' + c('mention')))
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const lower = text.toLowerCase();
    const frag = el.ownerDocument.createDocumentFragment();
    let last = 0;
    let found = false;
    for (let i = lower.indexOf('@'); i !== -1; i = lower.indexOf('@', i + 1)) {
      if (i < last) continue;
      if (i > 0 && /[\p{L}\p{N}_.]/u.test(text[i - 1])) continue;
      const u = names.find((n) => {
        if (!lower.startsWith(n.name.toLowerCase(), i + 1)) return false;
        const after = text[i + 1 + n.name.length];
        return after === undefined || !/[\p{L}\p{N}_]/u.test(after);
      });
      if (!u) continue;
      found = true;
      frag.append(text.slice(last, i));
      const span = el.ownerDocument.createElement('span');
      span.className = `${c('mention')}${u.id === meId ? ' is-me' : ''}`;
      span.textContent = text.slice(i, i + 1 + u.name.length);
      frag.append(span);
      last = i + 1 + u.name.length;
    }
    if (!found) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}
