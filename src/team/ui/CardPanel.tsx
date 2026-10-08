import { Component, MarkdownRenderer, Notice } from 'obsidian';
import { memo, useCallback, useContext, useEffect, useRef, useState } from 'preact/compat';
import { KanbanContext } from 'src/components/context';
import { c } from 'src/components/helpers';

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
      const parts: string[] = [];
      for (const file of Array.from(files)) {
        if (!/^(image|video)\//.test(file.type)) {
          new Notice(`Kanban: ${file.name} is not an image or video`);
          continue;
        }
        setBusy(`Uploading ${file.name}…`);
        try {
          const uploaded = await team.client.upload(boardId, file);
          parts.push(mediaMarkdown(uploaded));
        } catch (e) {
          new Notice(`Kanban: upload failed for ${file.name} (${e?.message || e})`);
        }
      }
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
        {busy || `📎 ${label}`}
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
  return <div ref={ref} className={`${c('comment-body')} markdown-rendered`} />;
});

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

  const load = useCallback(async () => {
    if (!team) return;
    try {
      setComments(await team.client.comments(boardId, cardId));
      setError(null);
    } catch (e) {
      setError(e?.message || String(e));
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
      const comment = await team.client.addComment(boardId, cardId, text);
      setComments((prev) => [...(prev || []), comment]);
      setDraft('');
    } catch (e) {
      new Notice(`Kanban: could not post comment (${e?.message || e})`);
    } finally {
      setSending(false);
    }
  }, [team, boardId, cardId, draft, sending]);

  const remove = useCallback(
    async (id: string) => {
      if (!team) return;
      try {
        await team.client.deleteComment(boardId, id);
        setComments((prev) => (prev || []).filter((c) => c.id !== id));
      } catch (e) {
        new Notice(`Kanban: could not delete comment (${e?.message || e})`);
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
      {comments?.map((cm) => {
        const name = cm.userName || team.userName(cm.userId);
        return (
          <div key={cm.id} className={c('comment')}>
            <span className={c('assignee')} style={{ '--assignee-hue': hueFor(cm.userId) }} title={name}>
              {initials(name)}
            </span>
            <div className={c('comment-main')}>
              <div className={c('comment-meta')}>
                <span className={c('comment-author')}>{name}</span>
                <span className={c('comment-time')}>{timeAgo(cm.createdAt)}</span>
                {cm.userId === me && (
                  <a className={c('comment-delete')} onClick={() => void remove(cm.id)} title="Delete comment">
                    Delete
                  </a>
                )}
              </div>
              <CommentBody markdown={cm.body} sourcePath={stateManager.file.path} />
            </div>
          </div>
        );
      })}
      <div className={c('comment-form')}>
        <textarea
          className={c('comment-input')}
          placeholder="Write a comment…"
          value={draft}
          rows={2}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
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
            {sending ? 'Sending…' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  );
});
