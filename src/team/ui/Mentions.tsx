import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'preact/compat';
import { c } from 'src/components/helpers';
import { cardWindowEscape } from 'src/components/copyOnClick';

import type { TeamManager } from '../TeamManager';
import { TeamUser } from '../types';
import { hueFor, initials } from './TeamBadges';
import type { StateManager } from 'src/StateManager';
import { CardRefInfo, buildCardIndex, rankCards, rankPeople } from 'src/cardRefs';

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

type Option = { kind: 'person'; user: TeamUser } | { kind: 'card'; card: CardRefInfo };

/**
 * "@" suggestions for a textarea/input: people who can see the card (comments on team
 * cards) and cards of the board (`@cardId`), filtered as you type.
 * Returns props for the field and the popup to render next to it (in a position:relative box).
 */
export function useMentions({
  team,
  boardId,
  cardId,
  stateManager,
  selfRefId,
  withPeople = true,
  value,
  setValue,
  inputRef,
}: {
  team?: TeamManager | null;
  boardId?: string;
  cardId?: string;
  /** Board whose cards can be referenced. Omit to offer people only. */
  stateManager?: StateManager | null;
  /** This card's own ref id (left out of the card list). */
  selfRefId?: string | null;
  withPeople?: boolean;
  value: string;
  setValue: (v: string) => void;
  inputRef: { current: HTMLTextAreaElement | HTMLInputElement | null };
}) {
  const [people, setPeople] = useState<TeamUser[] | null>(null);
  const [state, setState] = useState<{ start: number; query: string } | null>(null);
  const [index, setIndex] = useState(0);
  const loading = useRef(false);
  const usePeople = withPeople && !!team && !!boardId && !!cardId;

  const load = useCallback(() => {
    if (!usePeople || people || loading.current) return;
    loading.current = true;
    team!.client
      .cardPeople(boardId!, cardId!)
      .then((u) => setPeople(u))
      // Older servers: fall back to everyone this person can see.
      .catch(() => setPeople(team!.users))
      .finally(() => (loading.current = false));
  }, [usePeople, people, team, boardId, cardId]);

  const matches = useMemo<Option[]>(() => {
    if (!state) return [];
    const out: Option[] = [];
    if (usePeople && people) {
      for (const user of rankPeople(people, state.query, team?.user?.id, 6)) out.push({ kind: 'person', user });
    }
    if (stateManager?.state && !/\s/.test(state.query)) {
      for (const card of rankCards(buildCardIndex(stateManager.state), state.query, selfRefId, 6)) {
        out.push({ kind: 'card', card });
      }
    }
    return out;
  }, [state, people, usePeople, team?.user?.id, stateManager?.state, selfRefId]);
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

  const pick = (o: Option) => {
    const el = inputRef.current;
    if (!el || !state) return;
    const current = el.value;
    const caret = el.selectionStart ?? current.length;
    const token = o.kind === 'person' ? o.user.name : o.card.id;
    const next = `${current.slice(0, state.start)}@${token} ${current.slice(caret)}`;
    const pos = state.start + token.length + 2;
    el.value = next;
    setValue(next);
    setState(null);
    window.setTimeout(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    }, 0);
  };

  /** Call first in the field's keydown; true means the key was used by the picker. */
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

  const firstCard = matches.findIndex((o) => o.kind === 'card');
  const popup = open ? (
    <div className={c('mention-popup')} role="listbox">
      {matches.map((o, i) => (
        <Fragment key={o.kind === 'person' ? 'p:' + o.user.id : 'c:' + o.card.id}>
          {i === firstCard && firstCard > 0 && <div className={c('mention-section')}>Cards</div>}
          <div
            role="option"
            aria-selected={i === index}
            className={`${c('mention-option')} ${i === index ? 'is-selected' : ''}`}
            // mousedown, so the field keeps focus (and the phone keyboard stays up)
            onMouseDown={(e) => {
              e.preventDefault();
              pick(o);
            }}
            onMouseEnter={() => setIndex(i)}
          >
            {o.kind === 'person' ? (
              <>
                <span className={c('assignee')} style={{ '--assignee-hue': hueFor(o.user.id) }}>
                  {initials(o.user.name)}
                </span>
                <span className={c('mention-name')}>{o.user.name}</span>
                {o.user.id === team?.user?.id && <span className={c('mention-me')}>you</span>}
              </>
            ) : (
              <>
                <span className={`${c('card-ref-dot')} is-${o.card.status}`} />
                <span className={c('mention-name')}>{o.card.title}</span>
                <span className={c('mention-me')}>{o.card.laneTitle}</span>
              </>
            )}
          </div>
        </Fragment>
      ))}
    </div>
  ) : null;

  return {
    popup,
    onKeyDown,
    /** For onInput / onClick / onKeyUp of the field. */
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
