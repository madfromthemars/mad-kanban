#!/usr/bin/env node
// Usage (inside the container: docker compose exec kanban node cli.js ...):
//   node cli.js add-user <name>      create a user and print their join string
//   node cli.js list-users           list users
//   node cli.js remove-user <id>     disable a user (their token stops working)
//   node cli.js rename-user <id> <name>
//   node cli.js list-boards          list boards
import { createUser, disableUser, listUsers, openDb, renameUser } from './db.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const [cmd, ...args] = process.argv.slice(2);
const db = openDb(DATA_DIR);

switch (cmd) {
  case 'add-user': {
    const name = args.join(' ').trim();
    if (!name) die('usage: add-user <name>');
    try {
      const u = createUser(db, name);
      console.log(`created user ${u.name} (${u.id})`);
      console.log(`join string (paste into Obsidian > Kanban settings > Team):`);
      console.log(`${PUBLIC_URL}/#${u.token}`);
    } catch (e) {
      die(/UNIQUE/.test(String(e.message)) ? `a user named "${name}" already exists` : e.message);
    }
    break;
  }
  case 'list-users':
    for (const u of listUsers(db)) console.log(`${u.id}\t${u.name}`);
    break;
  case 'remove-user': {
    const id = args[0];
    if (!id) die('usage: remove-user <id>');
    console.log(disableUser(db, id) ? 'disabled' : 'no such user');
    break;
  }
  case 'rename-user': {
    const [id, ...rest] = args;
    const name = rest.join(' ').trim();
    if (!id || !name) die('usage: rename-user <id> <new name>');
    console.log(renameUser(db, id, name) ? 'renamed' : 'no such user');
    break;
  }
  case 'list-boards':
    for (const b of db.prepare('SELECT id, name, version FROM boards ORDER BY name').all())
      console.log(`${b.id}\t${b.name}\tv${b.version}`);
    break;
  default:
    die('commands: add-user <name> | list-users | rename-user <id> <name> | remove-user <id> | list-boards');
}

db.close();

function die(msg) {
  console.error(msg);
  process.exit(1);
}
