# Kanban team server

Sync server for **team boards** in the Mad Kanban Obsidian plugin.
Node 24 + built-in SQLite + WebSocket. One container, one volume.

## Run it on your test server

```sh
cd server
# edit docker-compose.yml: set ADMIN_TOKEN and PUBLIC_URL (e.g. http://10.0.0.5:8787)
docker compose up -d --build        # or: docker-compose up -d --build
curl http://localhost:8787/api/health
```

## Add people

Each person gets their own token. The CLI prints a join string they paste into Obsidian.

```sh
docker compose exec kanban node cli.js add-user "Mad"
docker compose exec kanban node cli.js list-users
docker compose exec kanban node cli.js remove-user <id>
docker compose exec kanban node cli.js list-boards
```

Or over HTTP with the admin token:

```sh
curl -X POST http://host:8787/api/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Alice"}'
```

## In Obsidian

1. Settings → Mad Kanban → **Team** → paste the join string → *Test connection*.
2. Command palette: **Create new team board** or **Open a team board**.
3. On a team card: right-click → **Assign to...**, or click the `+` on the card.
4. Any team card assigned to you shows up on your personal boards, in the list
   with the same name as its team list (fallback list: "Team", configurable).
   Dragging it there moves it on the team board for everyone.
   *Remove from my board* unassigns you; it never deletes the team card.

## Notes

- Tokens travel in plain text over `http://`. Put it behind HTTPS (Caddy, nginx)
  before using it outside your LAN.
- Every member of the server can see and join every board. There are no per-board
  permissions yet.
- Data lives in the `kanban-data` volume (`/data/kanban.db`). Back that up.
- Tests: `npm install && npm test` (needs Node ≥ 22.13).
