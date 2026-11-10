# Shared notes and canvases per project (design, not built yet)

Status (2026-11-10): **built** — steps 0–7 done, server deployed, plugin waiting for release (2.1.59). Results and "as built" notes at the end.

Step 0 (trial run): **GO**.

Status before that: proposal for review. Decisions so far: notes before the password vault; live
editing ("B") for notes, "almost live" for canvases.

---

## Part 1 — In plain words

### What you get

- Every project you're in shows up as a folder in your vault: `Team/catalog/`,
  `Team/onemenu/`, … Anything you put there (notes, canvases, pictures, PDFs) is shared
  with everyone in that project, on computers and phones.
- People who aren't in a project never receive its folder.
- **Notes are live.** If Bekhzod has the same note open, you see his cursor with his name
  and colour, and his typing appears as he types. Nothing ever needs "merging" by hand.
- **Offline works.** Edit on the phone with no internet; when it's back, your changes and
  everyone else's are combined automatically.
- **Canvases are almost live.** When someone moves a box or writes in it, you see it
  1–2 seconds later. Different boxes never clash. Only if two people change the *same*
  box at the same moment, the last one wins.
- Links between notes (`[[...]]`), Obsidian search, graph view, backlinks all work as
  usual, because the files are real files in your vault.
- Deleted notes go to the Trash (like cards) and can be restored for 30 days.
- Later: version history for a note ("show me this note as it was yesterday").

### What it looks like

- File list: the `Team` folder with one subfolder per project. A small coloured dot or
  cloud icon shows it's shared.
- Open note: at the top right, small avatars of who else has it open right now. Their
  cursors are coloured lines with a name label.
- Status bar: "Team notes: synced" / "offline — changes saved, will sync" / "syncing 3…".

### Rules for people

1. Only put things in `Team/<project>/` that the whole project may see.
2. Moving a note from `Team/catalog/` to `Team/onemenu/` changes who can see it, so the
   app asks "Share with onemenu instead of catalog?" first.
3. Don't sync the `Team` folder with another tool (iCloud, Syncthing, Obsidian Sync,
   git) at the same time — two syncers fight over one file. The app warns if it sees this.
4. Passwords never go into notes. That's what the vault (next project) is for.

### Build order (each step is usable on its own)

| Step | What | You can test |
|---|---|---|
| 0 | **Trial run (throwaway).** Live editing between two Obsidian windows + phone emulation; check canvas reload behaviour. Decide go/no-go. | Two windows typing into one note |
| 1 | **Server side:** stores notes, checks project membership, live updates over the existing connection. Tests. | — (API only) |
| 2 | **Folder sync:** `Team/<project>/` appears; create / rename / move / delete sync; note content syncs (not live yet). | Make a note on the Mac, see it on the phone |
| 3 | **Live editing:** cursors, names, typing in real time; offline edits merge. | Edit together with a teammate |
| 4 | **Canvases** almost live. | Move boxes together |
| 5 | **Pictures & files** in notes (reuses card uploads). | Paste a screenshot into a team note |
| 6 | **Trash** for notes, then **version history**. | Delete + restore |
| 7 | Phone polish, setup guide update, release notes. | Real phone |

Release after steps 3, 5 and 7 (or whenever you say "release").

---

## Part 2 — Technical design

### Building blocks

- **Yjs** (CRDT) on client and server. `y-codemirror.next` binds a `Y.Text` to
  CodeMirror 6, which is Obsidian's editor (the Relay plugin uses the same approach).
  `y-protocols` for sync + awareness (cursors). Adds ~90 KB to `main.js`.
- Server stays Node + `node:sqlite` + `ws`; adds `yjs` and `y-protocols` as dependencies.

### Identity: documents, not paths

- Every shared file is a **doc** with a stable id. The path is just a field, so renames
  and moves don't lose history or break live sessions.
- `docs` table: `id, project_id, path, kind ('md'|'canvas'|'file'), file_id (for binary),
  created_by, created_at, updated_at, deleted_at`.
- `doc_updates` table: `doc_id, seq, update BLOB, user_id, at` — append-only Yjs updates;
  compacted into one snapshot row when a doc passes ~500 updates or 1 MB.
- Path is unique per project among non-deleted docs. Path changes = `doc.move` op with
  version check (same idea as `card.update`'s `version`).

### Permissions

- Read/write = project member (the same `project_members` check as cards). Owner is NOT
  special here beyond being in projects (matches the vault decision: only people added).
  *Open question 3.*
- Every WebSocket doc message re-checks membership; removing someone from a project
  closes their subscriptions immediately and the client deletes that project's folder.

### Wire protocol (existing `/ws` connection)

The socket today only carries JSON (`hello`, `ping`, board events). Add:

- JSON control: `{type:'docs.list'}` → `{type:'docs', docs:[…]}` (tree of the projects
  the user can see), `{type:'doc.sub', id, sv}` / `{type:'doc.unsub', id}`.
- Binary frames for Yjs: `[1 byte kind][doc id 10 bytes][payload]` where kind = sync
  step 1 / step 2 / update / awareness. Keeps JSON parsing away from the hot path.
- REST for tree changes (create / move / delete / restore) so they get the same
  `OpError`, history and version handling as cards: `POST /api/docs/ops`.

### Client

- `src/team/notes/` (new): `NotesSync` (tree mirror + doc subscriptions),
  `MdBinding` (editor extension), `CanvasBinding`, `LocalStore` (offline state).
- **Tree mirror:** on connect, fetch the tree, then make the `Team/` folder match it.
  Local vault events inside `Team/` (`create`, `rename`, `delete`) become doc ops.
  A guard set of "paths we're writing ourselves" prevents echo loops.
- **Markdown, file closed:** the client keeps the `Y.Doc` in memory while subscribed;
  remote updates are written to disk (debounced 300 ms). External edits to the file
  (other plugins, a text editor) are diffed into `Y.Text` with diff-match-patch.
- **Markdown, file open:** `registerEditorExtension` adds a view plugin that reads the
  editor's file (`editorInfoField`); if it's a team doc, it attaches `yCollab(ytext,
  awareness)`. Disk writes are then left to Obsidian's own save; our writer skips that
  file while a binding is attached. Awareness carries `{name, colour: hueFor(userId)}`.
- **Canvas:** a canvas is JSON `{nodes, edges}`. Represent it as `Y.Map` of nodes and
  edges keyed by their ids, each a `Y.Map` of fields. On vault `modify` → diff JSON
  into the maps; remote change → write JSON. Obsidian's canvas view reloads on external
  change; **step 0 must confirm it doesn't fight an in-progress drag** (fallback: hold
  remote writes while the canvas view has focus + pointer is down).
- **Binary files:** not Yjs. Upload through the existing `/files` endpoint; the doc row
  points at `file_id`. Change = new upload; last writer wins (fine for screenshots/PDFs).
- **Offline:** Yjs state per doc saved locally in IndexedDB (`y-indexeddb`), which lives
  in Obsidian's app storage, not in the vault folder. On reconnect the normal sync steps
  exchange the missing updates. Tree ops made offline are queued and replayed; a rename
  that collides gets " (2)" appended.

### Things that can go wrong (and the answer)

| Risk | Answer |
|---|---|
| Another sync tool also writes `Team/` | Detect files changing that we didn't write while we're connected; show a one-time warning (same rule as team boards). |
| Obsidian editor internals change | Binding uses only public CM6 + `editorInfoField`; spike checks desktop + mobile. |
| Huge docs / long history | Compaction; per-doc size cap (e.g. 5 MB text). |
| A note moved into another project | Confirm dialog; server re-checks membership for the target project. |
| Two people create the same path offline | Second one becomes `name (2).md`. |
| Someone leaves a project | Their local `Team/<project>/` is removed on next sync (*open question 2*). |
| Server down | Everything keeps working locally; syncs later. |

### Tests

- Server: `server/test/docs.test.js` — membership, tree ops, two clients converging over
  real WebSockets with Yjs, compaction, removed member loses access, offline replay.
- Plugin: unit tests for the tree diff and canvas JSON ⇄ Y.Map mapping.
- E2E (throwaway vaults, `references/e2e-obsidian.md`): two Obsidian instances typing in
  one note; phone emulation; overflow audit for the avatar row.

---

## Decided

1. `Team/<project>/` at the vault root.
2. Someone removed from a project loses their local copy of its folder.
3. Every project member can create and delete; Trash is the safety net.
4. Cards link to notes with `@`, and @mentions in notes notify via Telegram — after step 7.
5. No Rust for now (see below).

## Speed (why not Rust, and what makes it fast instead)

- Plugin code must be JavaScript; Rust would only run there as WebAssembly, which adds
  size and startup time, especially on phones. Yjs in JS already handles documents far
  bigger than team notes.
- The server does very little per edit (check membership, append bytes, forward), for a
  team of a few people. The slow parts are the network and the disk, not the language.
- What actually makes it fast: binary frames, subscribing only to docs that are open or
  recently changed, a lightweight tree list instead of all content on connect, local
  IndexedDB cache so opening a note is instant, debounced disk writes, history
  compaction.
- If the server ever becomes the bottleneck, swap its Yjs for `yrs` (the Rust port, same
  wire format) without changing clients. Measure first.

## Step 0 results (trial run, throwaway code in ~/.hermes/cache/scratch/notes-spike)

Two Obsidian 1.15 vaults ("Ann", "Bob") + a ~150-line Yjs relay server.

Worked:
- Live typing between two open notes, named coloured cursors both ways, both typing in
  the same line at once → same text on both sides; Obsidian's own save writes it to disk.
- Note closed on one side → its file on disk still follows; a disk edit (other plugin)
  reaches the other person's open editor.
- Create, rename + move to another project folder, delete → arrive on the other side;
  files outside `Team/` never shared.
- Offline: server stopped, both edited (one in the editor, one on disk) and one created a
  new note → all merged after reconnect; server restart lost nothing.
- Phone mode (emulated): live editing works the same.
- Node-level: 7 ms keystroke latency locally, 2000 keystrokes in 0.5 s, ~1 byte/char.

Problems found → required in the real build:
1. **Canvas: writing the .canvas file while it's open loses the other person's unsaved
   drag** (Obsidian reloads the file and the box jumps back). Fix proven: for an open
   canvas, apply remote changes box by box through the canvas object (`moveAndResize`,
   `setText`, `importData`, `removeNode/Edge`), skip boxes being dragged/edited here, and
   push local changes from a `requestSave` hook (not from disk). Side effect: canvas sync
   went from ~2.2 s to ~0.2 s. After applying remote changes call the original
   `requestSave` so Obsidian saves the file itself.
2. **Hooks must be removed on unload** (use `monkey-around`'s uninstaller); a leftover
   hook sent edits to a dead plugin instance.
3. **Bind before the user can type.** Edits made in the first milliseconds after opening a
   note, before the binding attached (it ran in a `setTimeout`), were overwritten.
4. **Never treat a stale local file/canvas as the whole truth.** Wait until a doc is ready
   (local cache loaded + first server sync, or offline timeout) before binding or
   reading the file into it, and diff the file against the last synced copy (3-way), so a
   reopened old copy can't delete other people's boxes or text.
5. Canvas drag can't be driven by synthetic mouse events in tests; use the canvas object
   (`select`, `isDragging`, `moveTo`) in E2E tests.

## As built (steps 1–7)

Code: `server/notes.js` (+ `server/test/notes.test.js`, 12 tests), plugin `src/team/notes/`
(`NotesSync.ts` engine, `merge.ts` pure merge helpers + `test/notesMerge.test.ts`, `store.ts`
IndexedDB, `ui.ts` status bar / Trash / version history).

Differences from the plan above:
- **Which docs a device loads:** it doesn't subscribe to every doc. The server sends
  `docs.touched` (throttled, every 2 s per doc) to people who can see a doc but aren't
  subscribed; the device then fetches that one doc, writes it to disk and lets it go after
  30 s idle. Open notes/canvases stay subscribed.
- **Version history:** before the first change after 10 quiet minutes the server keeps a
  full copy (`doc_versions`, newest 60 per doc). Restoring is a normal edit everyone sees.
- **Attachments:** any non-.md/.canvas file is an attachment (whole file, last change wins),
  uploaded with `POST /api/docs/files`, swapped with `doc.setFile`.
- **Existing "Team" folder:** on first run, if the vault already has a `Team` folder with
  files, shared notes go to `Team (shared)` instead (setting `team-notes-folder`).
- **Project folders can't be renamed in the vault** (the rename is undone with a notice);
  they follow the project name from Manage team.

Safety rules learned in end-to-end testing (two real Obsidian vaults, local server):
1. Bind an editor only once Obsidian has loaded the file into it; only text the person
   really typed before binding is merged. (An empty, not-yet-loaded editor was once read
   as "delete everything".)
2. A bound editor may not be replaced wholesale except by the live sync (a transaction
   filter drops whole-document swaps such as Obsidian reloading the file from disk).
3. "Our own write" is recognised per exact event (create / rename-to / delete of a path,
   used once) and by content for modifies — never by a time window, which swallowed real
   edits and deletes.
4. File saves that repeat a text the doc already had (Obsidian saving a live editor a bit
   late) are echoes and are never merged again (hash list of recent texts per doc).
5. An open canvas syncs only through the canvas object; its file saves are never merged
   back, and an empty canvas file never means "delete every box".
6. A file moving out of project folders because its project folder is being renamed is
   never unshared.
7. A doc that isn't loaded on this device yet (offline, never fetched) is never merged into
   or bound; its local edits are merged after the first sync, against `base`.

E2E scripts (throwaway): `~/.hermes/cache/scratch/notes-e2e/t1–t6.mjs`, `reset.sh`.
