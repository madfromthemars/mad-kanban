# Connect your AI assistant to Mad Kanban

This lets an AI tool (Claude, Cursor, VS Code Copilot, Hermes, …) read and update our team board **as you**. You can give this file to your AI as-is: part 1 is for you, part 2 is for the AI.

---

## Part 1 — for you (2 minutes)

1. Update Mad Kanban to **2.1.53 or newer** (Settings → Mad Kanban → **Check now**).
2. Settings → Mad Kanban → **AI assistants** → **Create AI key**. Give it a name you'll recognise, like "Claude on my laptop".
3. The window shows your key **once**, with ready-made setups. Click **Copy** next to the one for your tool and paste it there (see the table below).
4. Restart the AI tool, then ask it: *"Use mad-kanban: what's on my plate?"*

| Tool | Where to paste |
|---|---|
| **Claude Code** | Run the `claude mcp add …` line in a terminal. |
| **Cursor** | `~/.cursor/mcp.json` (Cursor → Settings → MCP → Add) |
| **VS Code (Copilot)** | `.vscode/mcp.json`: same as Cursor, but use `"servers"` instead of `"mcpServers"` and add `"type": "http"` |
| **Claude Desktop** | Settings → Developer → Edit config → `claude_desktop_config.json` (needs Node.js installed) |
| **Hermes** | `hermes mcp add mad-kanban --url https://kanban.warehause-ac.uz/mcp --auth header`, then paste the key when asked |
| Anything else | Server address `https://kanban.warehause-ac.uz/mcp`, header `Authorization: Bearer <your key>`, transport "Streamable HTTP" |

ChatGPT's custom connectors only accept sign-in with OAuth, not a key, so ChatGPT can't connect for now.

**Safety**
- The AI sees **only your projects**, the same as you do in Obsidian. Your private ("Only me") cards stay yours; nobody else's AI can see them.
- It **can**: read cards, create cards, edit text, tick checklist items, move cards between lists, assign people from the card's project, and comment.
- It **can't**: delete cards, manage people, projects or boards, or create keys.
- Everything it does is saved under your name, marked **AI** (comments show a small "AI" label).
- Don't share the key or paste it in a chat. To cut the AI off, remove its key in Settings → Mad Kanban → Your devices (it has a robot icon).

---

## Part 2 — for the AI assistant

You are connected to the **mad-kanban** MCP server: the team's Kanban board. You act as the person who gave you the key, with their permissions.

**Reading (cheap first)**
- `overview` — who you are, lists, projects, people, common tags, what's overdue. Call it once at the start.
- `my_cards`, `find_cards` — one line per card: `[id] title | list | project | P<priority> | due | assignees | checklist done/total | comments | blocked`.
- `get_card` — full text, numbered checklist, referenced cards and comments. Only when you need details.
- `report` — what happened in a period (finished, new, comments per person, overdue, in progress). Use it for weekly or monthly reviews.

**Writing**
- `create_card`, `edit_card`, `tick_items`, `move_card`, `assign`, `comment`.
- Before creating a card, `find_cards` with a few words from its title, so you don't make a duplicate.

**How the team writes cards**
- First line: a short title. Optional due date `@{YYYY-MM-DD}` and `[priority:: 0-4]`, where **0 is the most urgent** (`create_card` adds both for you).
- Then a few lines in plain words, then a `#project` tag (see "Common tags" in `overview`), then `- [ ]` checklist items, one per thing to do or check.
- Write in the language the people on that card use (the team writes in Uzbek, Russian or English). Plain everyday words, no code paths unless the card is for a developer.
- Link another card with `@cardId` (the id shown in `[brackets]`). It shows as a clickable chip in Obsidian.
- In comments, `@Name` sends that person a Telegram message. Use it when someone has to do something.
- Work that is waiting on something goes to the **Backlog** list with a `Blocked by: …` line (`blocked_by` in `create_card`/`edit_card`). If the blocker is a card, use `@cardId`.
- Only tick checklist items you have actually checked. Move a card to **Done** when all its items are done.
- Never put passwords, API keys or tokens on cards or in comments. Say where the person should put them instead.
- If something needs deleting, or someone needs adding to a project, ask your person to do it in Obsidian.
