import classcat from 'classcat';
import { Component, MarkdownRenderer, Menu, Notice, Platform } from 'obsidian';
import { memo, useCallback, useContext, useEffect, useRef, useState } from 'preact/compat';
import { KanbanContext } from 'src/components/context';
import { c } from 'src/components/helpers';
import { Icon } from 'src/components/Icon/Icon';
import { cardWindowEscape, copyInlineCode, openClickedImage } from 'src/components/copyOnClick';

import { UploadCancelled } from '../TeamClient';
import { TeamComment, UploadedFile } from '../types';
import { hueFor, initials } from './TeamBadges';

/** Types the team server shows in place; it serves every other upload as a download. */
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/;
const INLINE_VIDEO = /^video\/(mp4|webm|ogg|quicktime|x-m4v)$/;

/** Markdown/HTML for an uploaded file: images and videos embed, anything else is a download link. */
export function fileMarkdown(f: UploadedFile) {
  if (INLINE_VIDEO.test(f.mime)) {
    return `<video src="${f.url}" controls preload="metadata" style="max-width:100%"></video>`;
  }
  const name = f.name.replace(/[[\]]/g, '');
  const url = f.url.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return INLINE_IMAGE.test(f.mime) ? `![${name}](${url})` : `[📎 ${name}](${url})`;
}

/** Files in a paste or drop, if any. */
export function filesOf(data: DataTransfer | null): File[] {
  return Array.from(data?.files || []);
}

interface ActiveUpload {
  id: number;
  target: string;
  name: string;
  size: number;
  /** 0..1, or null when the platform can't report progress */
  progress: number | null;
  cancel: () => void;
}

/** Uploads in flight, keyed by where their markdown will go (a card's description or comment box). */
const activeUploads = new Map<number, ActiveUpload>();
const uploadListeners = new Set<() => void>();
let nextUploadId = 1;
const emitUploads = () => uploadListeners.forEach((fn) => fn());

export function useUploads(target: string): ActiveUpload[] {
  const read = () => [...activeUploads.values()].filter((u) => u.target === target);
  const [list, setList] = useState(read);
  useEffect(() => {
    const fn = () => setList(read());
    uploadListeners.add(fn);
    fn();
    return () => {
      uploadListeners.delete(fn);
    };
  }, [target]);
  return list;
}

export const uploadTarget = (kind: 'description' | 'comment', boardId: string, cardId: string) =>
  `${kind}:${boardId}:${cardId}`;

/** Upload files to the team server, showing progress at `target`; returns markdown for the ones that worked. */
export async function uploadFiles(team: any, boardId: string, files: File[], target: string): Promise<string[]> {
  const parts: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      const ctrl = new AbortController();
      const entry: ActiveUpload = {
        id: nextUploadId++,
        target,
        name: file.name || 'file',
        size: file.size,
        progress: 0,
        cancel: () => ctrl.abort(),
      };
      activeUploads.set(entry.id, entry);
      emitUploads();
      try {
        const uploaded = await team.client.upload(boardId, file, {
          signal: ctrl.signal,
          onProgress: (p: number | null) => {
            activeUploads.set(entry.id, { ...entry, progress: p });
            emitUploads();
          },
        });
        parts.push(fileMarkdown(uploaded));
      } catch (e) {
        if (e instanceof UploadCancelled) return;
        new Notice(`Kanban: upload failed for ${file.name} (${e?.message || e})`);
        team.plugin.reportError('upload', e, { type: file.type, size: file.size });
      } finally {
        activeUploads.delete(entry.id);
        emitUploads();
      }
    })
  );
  return parts;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** One row per upload in flight: name, size, progress bar, cancel. */
export const UploadProgress = memo(function UploadProgress({ target }: { target: string }) {
  const uploads = useUploads(target);
  if (!uploads.length) return null;
  return (
    <div className={c('uploads')}>
      {uploads.map((u) => {
        const pct = u.progress == null ? null : Math.round(u.progress * 100);
        return (
          <div key={u.id} className={c('upload')} title={u.name}>
            <Icon name="lucide-upload" />
            <div className={c('upload-main')}>
              <div className={c('upload-line')}>
                <span className={c('upload-name')}>{u.name}</span>
                <span className={c('upload-meta')}>
                  {pct == null
                    ? `${formatSize(u.size)} · uploading…`
                    : pct >= 100
                      ? 'Processing…'
                      : `${formatSize(u.size * u.progress!)} of ${formatSize(u.size)} · ${pct}%`}
                </span>
              </div>
              <div className={`${c('upload-bar')}${pct == null || pct >= 100 ? ' is-indeterminate' : ''}`}>
                <div style={{ width: `${pct == null || pct >= 100 ? 100 : pct}%` }} />
              </div>
            </div>
            <button
              className={`${c('upload-cancel')} clickable-icon`}
              aria-label="Cancel upload"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                u.cancel();
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
});

/** Save files into the vault (personal cards); media embeds like ![[file.png]], other files link. */
export async function saveFilesToVault(app: any, sourcePath: string, files: File[]): Promise<string[]> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const name = file.name && file.name !== 'image.png' ? file.name : `Pasted image ${window.moment().format('YYYYMMDDHHmmss')}.png`;
      const path = await app.fileManager.getAvailablePathForAttachment(name, sourcePath);
      const created = await app.vault.createBinary(path, await file.arrayBuffer());
      const embed = /^(image|video|audio)\//.test(file.type) || file.type === 'application/pdf';
      parts.push((embed ? '!' : '') + app.fileManager.generateMarkdownLink(created, sourcePath));
    } catch (e) {
      new Notice(`Kanban: could not save ${file.name} (${e?.message || e})`);
    }
  }
  return parts;
}

function useTeam() {
  const { stateManager } = useContext(KanbanContext);
  return { team: stateManager.plugin?.team, stateManager };
}

/** Button that opens a file picker, uploads the files, and returns their markdown. */
export const AttachButton = memo(function AttachButton({
  boardId,
  target,
  onUploaded,
  label = 'Attach',
}: {
  boardId: string;
  target: string;
  onUploaded: (markdown: string) => void;
  label?: string;
}) {
  const { team } = useTeam();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploads = useUploads(target);
  const total = uploads.reduce((n, u) => n + u.size, 0);
  const done = uploads.reduce((n, u) => n + u.size * (u.progress ?? 0), 0);
  const known = uploads.every((u) => u.progress != null);
  const busy = uploads.length
    ? known && total
      ? `Uploading ${Math.min(99, Math.round((done / total) * 100))}%`
      : 'Uploading…'
    : null;

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!team || !files?.length) return;
      const picked = Array.from(files);
      if (inputRef.current) inputRef.current.value = '';
      const parts = await uploadFiles(team, boardId, picked, target);
      if (parts.length) onUploaded(parts.join('\n'));
    },
    [team, boardId, target, onUploaded]
  );

  if (!team) return null;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => void onFiles((e.target as HTMLInputElement).files)}
      />
      <button
        className={classcat([c('attach-button'), { 'is-busy': !!busy }])}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          inputRef.current?.click();
        }}
      >
        {busy || (
          <>
            <Icon name="lucide-paperclip" />
            {label}
          </>
        )}
      </button>
    </>
  );
});

const CommentBody = memo(function CommentBody({ markdown, sourcePath }: { markdown: string; sourcePath: string }) {
  const { stateManager } = useContext(KanbanContext);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const comp = new Component();
    comp.load();
    el.empty();
    void MarkdownRenderer.render(stateManager.app, markdown, el, sourcePath, comp);
    return () => comp.unload();
  }, [markdown, sourcePath]);
  return (
    <div
      ref={ref}
      className={`${c('comment-body')} markdown-rendered`}
      onClick={(e) => copyInlineCode(e as unknown as MouseEvent) || openClickedImage(e as unknown as MouseEvent)}
    />
  );
});

/** One-line preview of a comment for reply quotes. */
function snippetOf(body: string) {
  const text = body
    .replace(/<video\b[^>]*>(?:<\/video>)?/gi, ' [video] ')
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]/g, ' [image] ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 90 ? `${text.slice(0, 90)}…` : text || '…';
}

function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString();
}

/** Comment thread for a team card, shown in the card detail modal. */
export const TeamComments = memo(function TeamComments({ boardId, cardId }: { boardId: string; cardId: string }) {
  const { team, stateManager } = useTeam();
  const [comments, setComments] = useState<TeamComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<TeamComment | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const commentTarget = uploadTarget('comment', boardId, cardId);

  const startEdit = (cm: TeamComment) => {
    setReplyTo(null);
    setEditingId(cm.id);
    setEditDraft(cm.body);
  };

  const saveEdit = async (cm: TeamComment) => {
    const text = editDraft.trim();
    if (!team || savingEdit) return;
    if (!text || text === cm.body) {
      setEditingId(null);
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await team.client.editComment(boardId, cm.id, text);
      setComments((prev) => (prev || []).map((x) => (x.id === cm.id ? updated : x)));
      setEditingId(null);
    } catch (e) {
      new Notice(`Kanban: could not save the comment (${e?.message || e})`);
      team.plugin.reportError('comment.edit', e, { board: boardId, card: cardId });
    } finally {
      setSavingEdit(false);
    }
  };

  // While editing a comment, Esc cancels the edit instead of closing the card window.
  useEffect(() => {
    if (!editingId) return;
    const handler = () => {
      setEditingId(null);
      return true;
    };
    cardWindowEscape.push(handler);
    return () => {
      cardWindowEscape.remove(handler);
    };
  }, [editingId]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const startReply = (cm: TeamComment) => {
    setReplyTo(cm);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // While replying, Esc cancels the reply instead of closing the card window.
  useEffect(() => {
    if (!replyTo) return;
    const handler = () => {
      setReplyTo(null);
      return true;
    };
    cardWindowEscape.push(handler);
    return () => {
      cardWindowEscape.remove(handler);
    };
  }, [replyTo]);

  /** Scroll to a comment and flash it, like tapping a quote in a messenger. */
  const jumpTo = (id: string) => {
    const el = listRef.current?.querySelector(`[data-comment-id="${id}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.removeClass('is-flash');
    void el.offsetWidth;
    el.addClass('is-flash');
    window.setTimeout(() => el.removeClass('is-flash'), 1400);
  };

  // Comments newer than this were unread when the card was opened; they keep a "New" marker.
  const [readBefore, setReadBefore] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!team) return;
    try {
      const res = await team.client.comments(boardId, cardId);
      setComments(res.comments);
      setReadBefore((prev) => (prev === null ? res.lastReadAt : prev));
      setError(null);
      // Seeing the thread marks it read (here and on the board badges).
      if (
        res.comments.some(
          (cm) =>
            cm.userId !== team.user?.id &&
            (cm.createdAt > res.lastReadAt || (cm.editedAt || 0) > res.lastReadAt)
        )
      ) {
        void team.client.markCommentsRead(boardId, cardId).catch((): void => undefined);
      }
      team.updateCard(cardId, { unreadComments: 0, editedComments: 0, commentCount: res.comments.length });
    } catch (e) {
      setError(e?.message || String(e));
      team.plugin.reportError('comment.load', e, { board: boardId, card: cardId });
    }
  }, [team, boardId, cardId]);

  useEffect(() => {
    void load();
    if (!team) return;
    const fn = (b: string, cId: string) => {
      if (b === boardId && cId === cardId) void load();
    };
    team.emitter.on('comments', fn);
    return () => {
      team.emitter.off('comments', fn);
    };
  }, [load]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!team || !text || sending) return;
    setSending(true);
    try {
      const comment = await team.client.addComment(boardId, cardId, text, replyTo?.id);
      setComments((prev) => [...(prev || []), comment]);
      setDraft('');
      setReplyTo(null);
    } catch (e) {
      new Notice(`Kanban: could not post comment (${e?.message || e})`);
      team.plugin.reportError('comment.post', e, { board: boardId, card: cardId });
    } finally {
      setSending(false);
    }
  }, [team, boardId, cardId, draft, sending, replyTo]);

  const remove = useCallback(
    async (id: string) => {
      if (!team) return;
      try {
        await team.client.deleteComment(boardId, id);
        setComments((prev) => (prev || []).filter((c) => c.id !== id));
      } catch (e) {
        new Notice(`Kanban: could not delete comment (${e?.message || e})`);
        team.plugin.reportError('comment.delete', e, { board: boardId });
      }
    },
    [team, boardId]
  );

  // Phones: tap a comment for its actions, like in a messenger.
  const openCommentMenu = (e: MouseEvent, cm: TeamComment) => {
    const target = e.target as HTMLElement;
    if (target.closest('a, img, video, button, textarea, input, .' + c('comment-quote'))) return;
    if (editingId === cm.id) return;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle('Reply').setIcon('lucide-reply').onClick(() => startReply(cm)));
    menu.addItem((i) =>
      i
        .setTitle('Copy text')
        .setIcon('lucide-copy')
        .onClick(() => void navigator.clipboard.writeText(cm.body).then(() => new Notice('Copied')))
    );
    if (cm.userId === team?.user?.id) {
      menu.addItem((i) => i.setTitle('Edit').setIcon('lucide-pencil').onClick(() => startEdit(cm)));
      menu.addSeparator();
      menu.addItem((i) => {
        i.setTitle('Delete').setIcon('lucide-trash-2').onClick(() => void remove(cm.id));
        (i as any).setWarning?.(true);
      });
    }
    menu.showAtMouseEvent(e);
  };

  if (!team) return null;
  const me = team.user?.id;

  return (
    <div className={c('comments')}>
      <div className={c('comments-header')}>
        Comments
        {comments?.length ? <span className={c('comments-count')}>{comments.length}</span> : null}
      </div>
      {error && <div className={c('comments-error')}>Could not load comments: {error}</div>}
      {comments === null && !error && <div className={c('comments-empty')}>Loading…</div>}
      {comments?.length === 0 && <div className={c('comments-empty')}>No comments yet.</div>}
      <div ref={listRef}>
      {comments?.map((cm) => {
        const name = cm.userName || team.userName(cm.userId);
        const parent = cm.replyTo ? comments.find((p) => p.id === cm.replyTo) : null;
        const isNew = readBefore !== null && cm.userId !== me && cm.createdAt > readBefore;
        const isEdited = !isNew && readBefore !== null && cm.userId !== me && (cm.editedAt || 0) > readBefore;
        return (
          <div
            key={cm.id}
            data-comment-id={cm.id}
            className={`${c('comment')} ${isNew || isEdited ? 'is-new' : ''}`}
            onClick={Platform.isPhone ? (e) => openCommentMenu(e as unknown as MouseEvent, cm) : undefined}
          >
            <span className={c('assignee')} style={{ '--assignee-hue': hueFor(cm.userId) }} title={name}>
              {initials(name)}
            </span>
            <div className={c('comment-main')}>
              <div className={c('comment-meta')}>
                <span className={c('comment-author')}>{name}</span>
                <span className={c('comment-time')}>{timeAgo(cm.createdAt)}</span>
                {cm.editedAt && (
                  <span className={c('comment-edited')} title={`Edited ${new Date(cm.editedAt).toLocaleString()}`}>
                    edited
                  </span>
                )}
                {isNew && <span className={c('comment-new')}>New</span>}
                {isEdited && <span className={c('comment-new')}>Edited</span>}
                {Platform.isPhone ? null : (
                <span className={c('comment-actions-inline')}>
                  <a className={c('comment-reply')} onClick={() => startReply(cm)} title="Reply">
                    <Icon name="lucide-reply" />
                    Reply
                  </a>
                  {cm.userId === me && (
                    <a className={c('comment-reply')} onClick={() => startEdit(cm)} title="Edit comment">
                      <Icon name="lucide-pencil" />
                      Edit
                    </a>
                  )}
                  {cm.userId === me && (
                    <a className={c('comment-delete')} onClick={() => void remove(cm.id)} title="Delete comment">
                      Delete
                    </a>
                  )}
                </span>
                )}
              </div>
              {cm.replyTo && (
                <div
                  className={`${c('comment-quote')} ${parent ? '' : 'is-missing'}`}
                  style={parent ? { '--assignee-hue': hueFor(parent.userId) } : undefined}
                  onClick={() => parent && jumpTo(parent.id)}
                  title={parent ? 'Go to the original comment' : undefined}
                >
                  {parent ? (
                    <>
                      <span className={c('comment-quote-author')}>
                        {parent.userName || team.userName(parent.userId)}
                      </span>
                      <span className={c('comment-quote-text')}>{snippetOf(parent.body)}</span>
                    </>
                  ) : (
                    <span className={c('comment-quote-text')}>Original comment was deleted</span>
                  )}
                </div>
              )}
              {editingId === cm.id ? (
                <div className={c('comment-edit')}>
                  <textarea
                    className={c('comment-input')}
                    value={editDraft}
                    rows={3}
                    ref={(el) => {
                      if (el && document.activeElement !== el) setTimeout(() => el.focus(), 0);
                    }}
                    onInput={(e) => setEditDraft((e.target as HTMLTextAreaElement).value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void saveEdit(cm);
                      }
                    }}
                  />
                  <div className={c('comment-edit-actions')}>
                    <span className={c('cd-hint')}>⌘/Ctrl + Enter to save · Esc to cancel</span>
                    <button onClick={() => setEditingId(null)}>Cancel</button>
                    <button
                      className="mod-cta"
                      disabled={!editDraft.trim() || savingEdit}
                      onClick={() => void saveEdit(cm)}
                    >
                      {savingEdit ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <CommentBody markdown={cm.body} sourcePath={stateManager.file.path} />
              )}
            </div>
          </div>
        );
      })}
      </div>
      <div className={c('comment-form')}>
        {replyTo && (
          <div className={c('reply-bar')} style={{ '--assignee-hue': hueFor(replyTo.userId) }}>
            <Icon name="lucide-reply" />
            <div className={c('reply-bar-text')} onClick={() => jumpTo(replyTo.id)}>
              <span className={c('comment-quote-author')}>
                Reply to {replyTo.userName || team.userName(replyTo.userId)}
              </span>
              <span className={c('comment-quote-text')}>{snippetOf(replyTo.body)}</span>
            </div>
            <button className={`${c('reply-cancel')} clickable-icon`} aria-label="Cancel reply" onClick={() => setReplyTo(null)}>
              ×
            </button>
          </div>
        )}
        <UploadProgress target={commentTarget} />
        <textarea
          ref={inputRef}
          className={c('comment-input')}
          placeholder={replyTo ? 'Write a reply…' : 'Write a comment…'}
          value={draft}
          rows={2}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onPaste={(e) => {
            const files = filesOf((e as ClipboardEvent).clipboardData);
            if (!files.length) return;
            e.preventDefault();
            void uploadFiles(team, boardId, files, commentTarget).then((md) => {
              if (md.length) setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${md.join('\n')}` : md.join('\n')));
            });
          }}
          onDrop={(e) => {
            const files = filesOf((e as DragEvent).dataTransfer);
            if (!files.length) return;
            e.preventDefault();
            void uploadFiles(team, boardId, files, commentTarget).then((md) => {
              if (md.length) setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${md.join('\n')}` : md.join('\n')));
            });
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className={c('comment-actions')}>
          <AttachButton
            boardId={boardId}
            target={commentTarget}
            label="Attach"
            onUploaded={(md) => setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${md}` : md))}
          />
          <span className={c('cd-hint')}>⌘/Ctrl + Enter</span>
          <button className="mod-cta" disabled={!draft.trim() || sending} onClick={() => void send()}>
            {sending ? 'Sending…' : replyTo ? 'Reply' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  );
});
