import { Component, MarkdownRenderer, Notice } from 'obsidian';
import { memo, useCallback, useContext, useEffect, useRef, useState } from 'preact/compat';
import { KanbanContext } from 'src/components/context';
import { c } from 'src/components/helpers';
import { Icon } from 'src/components/Icon/Icon';
import { cardWindowEscape, copyInlineCode } from 'src/components/copyOnClick';

import { TeamComment, UploadedFile } from '../types';
import { hueFor, initials } from './TeamBadges';

/** Markdown/HTML snippet that embeds an uploaded file. */
export function mediaMarkdown(f: UploadedFile) {
  if (f.mime.startsWith('video/')) {
    return `<video src="${f.url}" controls preload="metadata" style="max-width:100%"></video>`;
  }
  const alt = f.name.replace(/[[\]]/g, '');
  return `![${alt}](${f.url})`;
}

/** Image/video files in a paste or drop, if any. */
export function mediaFilesOf(data: DataTransfer | null): File[] {
  return Array.from(data?.files || []).filter((f) => /^(image|video)\//.test(f.type));
}

/** Upload images/videos to the team server; returns markdown embeds for the ones that worked. */
export async function uploadMedia(team: any, boardId: string, files: File[]): Promise<string[]> {
  const parts: string[] = [];
  for (const file of files) {
    if (!/^(image|video)\//.test(file.type)) {
      new Notice(`Kanban: ${file.name} is not an image or video`);
      continue;
    }
    const notice = new Notice(`Uploading ${file.name}…`, 0);
    try {
      const uploaded = await team.client.upload(boardId, file);
      parts.push(mediaMarkdown(uploaded));
    } catch (e) {
      new Notice(`Kanban: upload failed for ${file.name} (${e?.message || e})`);
      team.plugin.reportError('upload', e, { type: file.type, size: file.size });
    } finally {
      notice.hide();
    }
  }
  return parts;
}

/** Save images/videos into the vault (personal cards); returns embeds like ![[file.png]]. */
export async function saveMediaToVault(app: any, sourcePath: string, files: File[]): Promise<string[]> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const name = file.name && file.name !== 'image.png' ? file.name : `Pasted image ${window.moment().format('YYYYMMDDHHmmss')}.png`;
      const path = await app.fileManager.getAvailablePathForAttachment(name, sourcePath);
      const created = await app.vault.createBinary(path, await file.arrayBuffer());
      parts.push('!' + app.fileManager.generateMarkdownLink(created, sourcePath));
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

/** Button that opens a file picker, uploads images/videos, and returns embed markdown. */
export const AttachButton = memo(function AttachButton({
  boardId,
  onUploaded,
  label = 'Attach',
}: {
  boardId: string;
  onUploaded: (markdown: string) => void;
  label?: string;
}) {
  const { team } = useTeam();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!team || !files?.length) return;
      setBusy('Uploading…');
      const parts = await uploadMedia(team, boardId, Array.from(files));
      setBusy(null);
      if (inputRef.current) inputRef.current.value = '';
      if (parts.length) onUploaded(parts.join('\n'));
    },
    [team, boardId, onUploaded]
  );

  if (!team) return null;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => void onFiles((e.target as HTMLInputElement).files)}
      />
      <button
        className={c('attach-button')}
        disabled={!!busy}
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
      onClick={(e) => copyInlineCode(e as unknown as MouseEvent)}
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
                <div onDblClick={(e) => !(e.target as HTMLElement).closest('code, a, img, video') && startReply(cm)}>
                  <CommentBody markdown={cm.body} sourcePath={stateManager.file.path} />
                </div>
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
        <textarea
          ref={inputRef}
          className={c('comment-input')}
          placeholder={replyTo ? 'Write a reply…' : 'Write a comment…'}
          value={draft}
          rows={2}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onPaste={(e) => {
            const files = mediaFilesOf((e as ClipboardEvent).clipboardData);
            if (!files.length) return;
            e.preventDefault();
            void uploadMedia(team, boardId, files).then((md) => {
              if (md.length) setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${md.join('\n')}` : md.join('\n')));
            });
          }}
          onDrop={(e) => {
            const files = mediaFilesOf((e as DragEvent).dataTransfer);
            if (!files.length) return;
            e.preventDefault();
            void uploadMedia(team, boardId, files).then((md) => {
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
