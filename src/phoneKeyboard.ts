import { Platform } from 'obsidian';

import type KanbanPlugin from './main';

/**
 * Phones: keep the field you're typing in above the on-screen keyboard.
 *
 * Obsidian mobile doesn't resize the page when the keyboard opens; it sets
 * `--keyboard-height` on <html> and shrinks only `.app-container`. Modals live
 * outside it, so our card window and dialogs stayed full height and the
 * keyboard covered their lower half (the comment box included). The CSS
 * (`.is-phone .modal-container:has(...)`) lifts the bottom of our modals by
 * `--keyboard-height`; this scrolls the focused field into the space left.
 */
const FIELD = 'input:not([type=checkbox]):not([type=file]):not([type=radio]), textarea, [contenteditable="true"], .cm-content';

function keyboardHeight(win: Window) {
  const v = win.getComputedStyle(win.document.documentElement).getPropertyValue('--keyboard-height');
  return parseFloat(v) || 0;
}

function revealFocused(win: Window) {
  const el = win.document.activeElement as HTMLElement | null;
  if (!el || !el.matches?.(FIELD)) return;
  // Only our own UI: plugin modals and the board.
  if (!el.closest('[class*="kanban-plugin__"]')) return;
  // The CodeMirror editor scrolls its cursor itself; just make the editor box visible.
  const target = (el.closest('.cm-editor') as HTMLElement) || el;
  target.scrollIntoView({ block: 'nearest' });
}

export function bindPhoneKeyboard(plugin: KanbanPlugin, win: Window) {
  if (!Platform.isPhone) return;
  let timer = 0;
  const later = (ms: number) => {
    win.clearTimeout(timer);
    // Wait for the modal to shrink (CSS reads --keyboard-height) before scrolling.
    timer = win.setTimeout(() => revealFocused(win), ms);
  };
  plugin.registerDomEvent(win, 'keyboardDidShow' as keyof WindowEventMap, () => later(50));
  // Moving to another field while the keyboard is already up fires no keyboard event.
  plugin.registerDomEvent(win.document, 'focusin', () => {
    if (keyboardHeight(win) > 0) later(100);
  });
}
