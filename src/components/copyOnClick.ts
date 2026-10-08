import { Notice } from 'obsidian';

/**
 * Inline `code` in rendered card text copies itself when clicked.
 * Returns true when the click was handled.
 */
export function copyInlineCode(e: MouseEvent): boolean {
  const target = e.target as HTMLElement | null;
  const code = target?.closest?.('code') as HTMLElement | null;
  if (!code || code.closest('pre')) return false;
  e.preventDefault();
  e.stopPropagation();
  const text = code.textContent || '';
  void navigator.clipboard.writeText(text).then(
    () => {
      code.addClass('is-copied');
      window.setTimeout(() => code.removeClass('is-copied'), 1200);
      new Notice(`Copied: ${text.length > 40 ? text.slice(0, 40) + '…' : text}`, 1500);
    },
    () => new Notice('Kanban: could not copy to clipboard')
  );
  return true;
}

/**
 * Handlers that get the first chance at Escape inside the card window (newest first).
 * A handler returns true when it used the key, which keeps the window open.
 */
export const cardWindowEscape: Array<() => boolean> = [];
