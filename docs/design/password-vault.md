# Password vault per project (design, not built yet)

Status: proposal for review. Decisions so far (from the user):
- Built into Mad Kanban (not Vaultwarden).
- Every secret has its own list of people who can open it. Being in the project is required
  but not enough.
- **Nobody** opens a secret they weren't added to — the owner included. No master copy.
- **No unlock password.** Keys live on each person's devices; a new device gets them through
  the existing "Add a device" QR code.
- Secrets never go into vault files.

---

## Part 1 — In plain words

### What you get

- In every project, a **Passwords** list (command "Passwords", and a 🔑 button in the team
  board's toolbar). It shows only the secrets **you** were added to.
- A secret is a login (username, password, website, note) or a free-form secret (API key,
  server key, recovery codes…). Fields can be marked hidden.
- **Copy** buttons for each field. Copied secrets are wiped from the clipboard after 30 s.
  **Show** reveals a hidden field for 20 s.
- **Share** a secret with chosen people in the project. **Remove** someone: they lose access
  at once, and the app reminds you to change that password (they may have copied it).
- History per secret: who created it, who changed it, who shared it with whom, and who
  opened or copied it (as reported by their app).

### How it's kept safe (the important part)

1. **The server only ever stores scrambled data.** Every secret is locked on your device
   before it's uploaded. If the server is hacked, the attacker gets unreadable data.
2. **Each person has a personal key**, made on their first device. It never leaves their
   devices unencrypted, and it's stored in Obsidian's app storage — not in the vault folder,
   so it can't leak through iCloud/Syncthing/Obsidian Sync.
3. **Each secret has its own key.** Sharing a secret = locking its key with the other
   person's public key. Only they can unlock it.
4. **New device:** "Add a device" QR already signs it in. The QR now also carries a one-time
   key (the server never sees it), so your personal key moves to the new device safely.
5. **A device you already use** (signed in before this feature): it shows a short code like
   `K7-4Q`; open Mad Kanban on one of your other devices, check the same code appears there,
   tap **Allow**.
6. **Protection against a lying server:** the app remembers each teammate's key the first
   time it sees it. If the server ever hands out a different key for someone, you get a
   warning instead of silently sharing with the wrong key. Each person also has a short
   "safety code" you can compare face to face if you want to be sure.

### What it costs (you chose this; written down so nobody is surprised)

- Lose **all** your devices → your personal key is gone. Secrets others also have: they share
  them with you again. Secrets only you had: gone (reset the real password at the service).
  → Optional: print or save a **recovery code** when you set up (see question 3).
- Anyone holding your unlocked laptop/phone can open your secrets in Mad Kanban. Later we can
  ask for Face ID / fingerprint on phones before showing passwords.
- "Who opened it" history is what the apps report; a modified app could skip it.

### Build order

| Step | What | You can test |
|---|---|---|
| 0 | **Trial run (throwaway):** the crypto library + key storage in Obsidian desktop and phone mode; key moving through a QR link. | Two vaults, one secret shared |
| 1 | **Server:** stores scrambled secrets and who-has-a-key rows; project checks; history; tests. Server never decrypts. | — |
| 2 | **Your key:** made on first use; QR move to new devices; "Allow this device" for existing ones; key warnings. | Set up on Mac + phone |
| 3 | **Passwords list:** add / edit / copy / show / search, per project, phone layout. | Save a real login |
| 4 | **Sharing:** pick people, remove people (with the "change the password" reminder), history. | Share with Bekhzod |
| 5 | Recovery code (if wanted), polish, guide, release. | Real phone |

---

## Part 2 — Technical design

### Crypto (no home-made crypto)

- Library: **tweetnacl** (audited, pure JS, ~30 KB, works the same in Electron and mobile
  WebViews — no dependency on which WebCrypto curves a WebView has).
- Person key: `nacl.box` key pair (X25519). Signing key pair (`nacl.sign`, Ed25519) for
  signing the person's own key rows, so the server can't forge "Ann shared this with X".
- Secret: random 32-byte item key; content = `nacl.secretbox(JSON, nonce, itemKey)`.
- Share: `wrapped = nacl.box(itemKey, nonce, recipientPub, sharerSecret)` + sharer's public
  key id, signed by the sharer.
- Everything versioned (`v: 1`) so the scheme can change later.

### Key storage on a device

- IndexedDB `mk-vault-<server>-<userId>` (app storage, outside the vault folder).
- Desktop: additionally sealed with Electron `safeStorage` (OS keychain) when available.

### Moving the key to a device

- **QR (new device):** `pair#<code>.<k>` — `k` = 32 random bytes, only in the link fragment.
  The old device uploads `secretbox(personKey, k)` attached to the pairing code; the new
  device redeems the code (as today), downloads the box, opens it with `k`. One use, 10 min.
  `pair.html` passes `k` on to `obsidian://mad-kanban?...&k=` (never to the server).
- **Existing device:** makes a temporary key pair, posts its public key as a request; your
  other device shows it with a 4+4-character code derived from that public key; **Allow** →
  it uploads `box(personKey, requestPub)`. Requests expire after 15 min.

### Server (stores only what it can't read)

- `vault_people(user_id, box_pub, sign_pub, created_at)` — one current key per person;
  changing it is logged and warned about to everyone who pinned the old one.
- `vault_items(id, project_id, version, box, created_by, created_at, updated_by, updated_at, deleted_at)`
  — title and all fields are inside `box`.
- `vault_access(item_id, user_id, wrapped, by_user, by_pub, sig, created_at)` — a person can
  read an item only with a row here **and** membership in its project.
- `vault_transfers` (QR / allow-device boxes, short-lived), `vault_events` (history).
- Rules the server enforces: list/read only items you have a row for; share only with project
  members who have set up a key; removed from the project → your rows are deleted; the
  server never returns other people's `wrapped` keys. No MCP, no Telegram, no logs with content.
- Removing someone = new item key, re-encrypt, re-wrap for the rest (done by the remover's
  device), plus the "change it at the service" reminder.

### Plugin

- `src/team/vault/` — `crypto.ts` (pure, unit-tested), `keys.ts` (storage, transfer),
  `VaultClient` calls, `ui/` (list, item window, share picker; styled components only).
- Clipboard: `navigator.clipboard.writeText`, cleared after 30 s if it still holds our value.
- Secrets are only ever in memory while the window is open.

---

## Open questions

1. Should people **without** access see that a secret exists (its name), or not at all?
   (Recommended: not at all — names like "prod DB root" are information too.)
2. Who can share / remove people: anyone who has the secret, or only its creator and hosts?
   (Recommended: anyone who has it can **add** people from the project; only the creator and
   hosts can **remove** people.)
3. Recovery code: optional "save this code" at setup, to get your key back if you lose every
   device? (Recommended: yes, optional — it's the one safety net without an owner copy.)
4. Kinds of secrets: logins + free-form secrets first; 2FA (TOTP) codes later?
   (Recommended: yes, TOTP later.)
