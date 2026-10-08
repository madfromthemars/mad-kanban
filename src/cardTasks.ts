/**
 * Helpers for a card's checklist (markdown `- [ ]` lines), due date (`@{date}` in the
 * first line) and priority ordering. Pure functions so they can be unit tested.
 */

const TASK_RE = /^(\s*(?:>\s*)*[-+*]\s+\[)([^\]])(\]\s+)(.*)$/;

export interface CardTask {
  /** Line index inside the body */
  line: number;
  checked: boolean;
  text: string;
}

export function parseTasks(body: string): CardTask[] {
  const out: CardTask[] = [];
  body.split('\n').forEach((l, line) => {
    const m = l.match(TASK_RE);
    if (m) out.push({ line, checked: m[2] !== ' ', text: m[4] });
  });
  return out;
}

function mapLine(body: string, line: number, fn: (l: string) => string | null) {
  const lines = body.split('\n');
  if (line < 0 || line >= lines.length) return body;
  const next = fn(lines[line]);
  if (next === null) lines.splice(line, 1);
  else lines[line] = next;
  return lines.join('\n');
}

export function toggleTask(body: string, line: number, checked: boolean) {
  return mapLine(body, line, (l) => {
    const m = l.match(TASK_RE);
    return m ? `${m[1]}${checked ? 'x' : ' '}${m[3]}${m[4]}` : l;
  });
}

export function editTask(body: string, line: number, text: string) {
  return mapLine(body, line, (l) => {
    const m = l.match(TASK_RE);
    return m ? `${m[1]}${m[2]}${m[3]}${text}` : l;
  });
}

export function deleteTask(body: string, line: number) {
  return mapLine(body, line, (l) => (TASK_RE.test(l) ? null : l));
}

/** Add an unchecked item after the last checklist line, or at the end of the body. */
export function addTask(body: string, text: string) {
  const lines = body ? body.split('\n') : [];
  const tasks = parseTasks(body);
  const item = `- [ ] ${text}`;
  if (tasks.length) {
    lines.splice(tasks[tasks.length - 1].line + 1, 0, item);
  } else {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) lines.push('');
    lines.push(item);
  }
  return lines.join('\n');
}

/** Move a checklist item to another checklist position (by task index). */
export function moveTask(body: string, from: number, to: number) {
  const tasks = parseTasks(body);
  if (from === to || !tasks[from] || !tasks[to]) return body;
  const lines = body.split('\n');
  const [moved] = lines.splice(tasks[from].line, 1);
  const target = parseTasks(lines.join('\n'))[to > from ? to - 1 : to];
  const at = target ? (to > from ? target.line + 1 : target.line) : lines.length;
  lines.splice(at, 0, moved);
  return lines.join('\n');
}

// ---------- due date ----------

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dateTokenRe(trigger: string) {
  const t = escapeRe(trigger);
  return new RegExp(`\\s*${t}(?:\\{[^}]*\\}|\\[\\[[^\\]]*\\]\\]|\\[[^\\]]*\\]\\([^)]*\\))`, 'g');
}

/** Set (or clear, with null) the `@{date}` token on the card's first line. */
export function setDueInTitle(titleRaw: string, date: string | null, trigger = '@') {
  const lines = titleRaw.split('\n');
  let first = (lines[0] || '').replace(dateTokenRe(trigger), '').trimEnd();
  if (date) first = `${first} ${trigger}{${date}}`;
  lines[0] = first;
  return lines.join('\n');
}

/** Remove date/time tokens (`@{…}`, `@@{…}`, `@[[…]]`) for display. */
export function stripDateTokens(text: string) {
  return text.replace(/\s*@{1,2}(?:\{[^}]*\}|\[\[[^\]]*\]\])/g, '').trim();
}

// ---------- priority ----------

/** Highest first, cards without a priority last. */
export function priorityRank(p: string | undefined | null) {
  switch (p) {
    case '0':
      return 0;
    case '1':
      return 1;
    case '2':
      return 2;
    case '4':
      return 3;
    default:
      return 4;
  }
}

/** Stable sort by priority; returns the same array when already in order. */
export function sortByPriority<T>(items: T[], getPriority: (item: T) => string | undefined) {
  let sorted = true;
  for (let i = 1; i < items.length; i++) {
    if (priorityRank(getPriority(items[i - 1])) > priorityRank(getPriority(items[i]))) {
      sorted = false;
      break;
    }
  }
  if (sorted) return items;
  return items
    .map((item, i) => ({ item, i, r: priorityRank(getPriority(item)) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}

// ---------- description / checklist / tags as separate parts ----------

// A tag: '#' after start or whitespace, letters/digits/_-/ and at least one non-digit.
const TAG_TOKEN = /(^|\s)#((?=[\p{L}\p{N}_\-/]*[\p{L}_\-/])[\p{L}\p{N}_\-/]+)/gu;

export function normalizeTag(tag: string) {
  return tag.trim().replace(/^#+/, '').replace(/\s+/g, '-');
}

/** Split a leading YAML frontmatter block (kept verbatim) from the rest. */
export function splitFrontmatter(text: string) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? { frontmatter: m[0], rest: text.slice(m[0].length) } : { frontmatter: '', rest: text };
}

export function tagsIn(text: string) {
  const out: string[] = [];
  const re = new RegExp(TAG_TOKEN.source, TAG_TOKEN.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

export function removeTagTokens(text: string, only?: string) {
  let changed = false;
  const out = text.replace(TAG_TOKEN, (all, pre, tag) => {
    if (only !== undefined && tag.toLowerCase() !== only.toLowerCase()) return all;
    changed = true;
    return pre;
  });
  // Close the gap the tag leaves inside a sentence.
  return changed ? out.replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ') : out;
}

export interface CardParts {
  description: string;
  /** Raw checklist lines */
  tasks: string[];
  tags: string[];
}

/** Description (no checklist lines, no tags), checklist lines and tags of a card body. */
export function splitCardBody(body: string): CardParts {
  const description: string[] = [];
  const tasks: string[] = [];
  const tags: string[] = [];
  for (const line of body.split('\n')) {
    if (TASK_RE.test(line)) {
      tasks.push(line);
      continue;
    }
    for (const t of tagsIn(line)) if (!tags.includes(t)) tags.push(t);
    description.push(removeTagTokens(line).replace(/[ \t]+$/, ''));
  }
  return {
    description: description.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    tasks,
    tags,
  };
}

/** Inverse of splitCardBody: description, then the checklist, then one line of tags. */
export function joinCardBody(parts: CardParts) {
  return [parts.description.trim(), parts.tasks.join('\n'), parts.tags.map((t) => `#${t}`).join(' ')]
    .filter((s) => s.trim())
    .join('\n\n');
}
