import { Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from 'obsidian';

import type KanbanPlugin from 'src/main';
import type { StateManager } from 'src/StateManager';
import { CardRefInfo, buildCardIndex, rankCards } from 'src/cardRefs';
import { TeamUser } from 'src/team/types';
import { hueFor, initials } from 'src/team/ui/TeamBadges';

import { c } from '../helpers';
import { stateManagerField } from './MarkdownEditor';

type Suggestion = { kind: 'person'; user: TeamUser } | { kind: 'card'; card: CardRefInfo };

/** Card row for a suggestion list (DOM): status dot, title, list name. */
export function renderCardOption(el: HTMLElement, card: CardRefInfo) {
  el.addClass(c('ref-option'));
  el.createSpan({ cls: `${c('card-ref-dot')} is-${card.status}` });
  el.createSpan({ cls: c('ref-option-title'), text: card.title });
  el.createSpan({ cls: c('ref-option-meta'), text: card.laneTitle });
}

/** `@` in a card editor (title/description): cards of the board. */
export class CardRefSuggest extends EditorSuggest<Suggestion> {
  constructor(private plugin: KanbanPlugin) {
    super(plugin.app);
    this.limit = 10;
  }

  private stateManagerOf(editor: Editor): StateManager | null {
    try {
      return ((editor as any).cm?.state?.field?.(stateManagerField, false) as StateManager) || null;
    } catch {
      return null;
    }
  }

  private sm: StateManager | null = null;

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const sm = this.stateManagerOf(editor);
    if (!sm) return null; // only inside Kanban card editors
    const line = editor.getLine(cursor.line).slice(0, cursor.ch);
    const m = /(?:^|[\s([{"'«])@([^\s@{}[\]]{0,30})$/.exec(line);
    if (!m) return null;
    this.sm = sm;
    return {
      start: { line: cursor.line, ch: cursor.ch - m[1].length - 1 },
      end: cursor,
      query: m[1],
    };
  }

  getSuggestions(ctx: EditorSuggestContext): Suggestion[] {
    const sm = this.sm;
    if (!sm?.state) return [];
    // Cards only: @people only notify from comments, so they're offered there.
    const out: Suggestion[] = [];
    for (const card of rankCards(buildCardIndex(sm.state), ctx.query, null, 6)) out.push({ kind: 'card', card });
    return out;
  }

  renderSuggestion(s: Suggestion, el: HTMLElement) {
    if (s.kind === 'person') {
      el.addClass(c('ref-option'));
      const av = el.createSpan({ cls: c('assignee'), text: initials(s.user.name) });
      av.style.setProperty('--assignee-hue', String(hueFor(s.user.id)));
      el.createSpan({ cls: c('ref-option-title'), text: s.user.name });
      el.createSpan({ cls: c('ref-option-meta'), text: 'person' });
    } else {
      renderCardOption(el, s.card);
    }
  }

  selectSuggestion(s: Suggestion) {
    const ctx = this.context;
    if (!ctx) return;
    const text = s.kind === 'person' ? `@${s.user.name} ` : `@${s.card.id} `;
    ctx.editor.replaceRange(text, ctx.start, ctx.end);
    ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + text.length });
    this.close();
  }
}
