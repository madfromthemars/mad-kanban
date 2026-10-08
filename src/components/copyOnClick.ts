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

/** Show an image full size over everything; click anywhere or press Esc to close. */
export function openLightbox(src: string) {
  const doc = activeDocument;
  const overlay = doc.body.createDiv({ cls: 'kanban-plugin__image-lightbox' });
  overlay.createEl('img', { attr: { src } });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  // Inside the card window, Esc closes the image first, not the window.
  const escapeHandler = () => {
    close();
    return true;
  };
  const close = () => {
    overlay.remove();
    doc.removeEventListener('keydown', onKey, true);
    cardWindowEscape.remove(escapeHandler);
  };

  cardWindowEscape.push(escapeHandler);
  doc.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', close);
}

/** Click on an image in rendered card text / comments opens it full size. Returns true if handled. */
export function openClickedImage(e: MouseEvent): boolean {
  const target = e.target as HTMLElement | null;
  if (!target || target.tagName !== 'IMG') return false;
  e.preventDefault();
  e.stopPropagation();
  openLightbox((target as HTMLImageElement).src);
  return true;
}
