import { App, TAbstractFile, TFile, TFolder, Vault, normalizePath } from 'obsidian';

const illegalCharsRegEx = /[\\/:"*?<>|]+/g;
const condenceWhiteSpaceRE = /\s+/g;

// Date format for lastMoved: YYYY-MM-DD
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

// Build initial card file content with frontmatter
export function buildCardFileContent(body: string = ''): string {
  const today = formatDate(new Date());
  return `---
lastMoved: ${today}
---
${body}`;
}

// Parse lastMoved date from card content
export function parseLastMoved(content: string): Date | null {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];
  const lastMovedMatch = frontmatter.match(/lastMoved:\s*(\d{4}-\d{2}-\d{2})/);
  if (!lastMovedMatch) return null;

  const date = new Date(lastMovedMatch[1]);
  return isNaN(date.getTime()) ? null : date;
}

// Update lastMoved in card content
export function updateLastMoved(content: string): string {
  const today = formatDate(new Date());
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);

  if (frontmatterMatch) {
    // Update existing frontmatter
    const frontmatter = frontmatterMatch[1];
    if (frontmatter.includes('lastMoved:')) {
      const updatedFrontmatter = frontmatter.replace(
        /lastMoved:\s*\d{4}-\d{2}-\d{2}/,
        `lastMoved: ${today}`
      );
      return content.replace(frontmatterMatch[1], updatedFrontmatter);
    } else {
      // Add lastMoved to existing frontmatter
      const updatedFrontmatter = `lastMoved: ${today}\n${frontmatter}`;
      return content.replace(frontmatterMatch[1], updatedFrontmatter);
    }
  } else {
    // No frontmatter, add it
    return `---
lastMoved: ${today}
---
${content}`;
  }
}

// Calculate card age in days
export function calculateCardAge(lastMoved: Date | null): number {
  if (!lastMoved) return 0;
  const now = new Date();
  const diffMs = now.getTime() - lastMoved.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// Get age class based on days
export function getCardAgeClass(ageDays: number): string {
  if (ageDays >= 14) return 'card-age-old';
  if (ageDays >= 7) return 'card-age-stale';
  if (ageDays >= 3) return 'card-age-aging';
  return '';
}

export function sanitizeName(rawTitle: string) {
  return rawTitle
    .replace(illegalCharsRegEx, ' ')
    .trim()
    .replace(condenceWhiteSpaceRE, ' ')
    .replace(/[. ]+$/g, '');
}

/** Parent folder path, with the vault root as '' (Obsidian reports it as '/'). */
export function parentDirPath(file: TAbstractFile | null | undefined) {
  const p = file?.parent?.path || '';
  return p === '/' ? '' : p;
}

export function getBoardFolderPath(kanbanFile: TFile) {
  const parentPath = parentDirPath(kanbanFile);
  const folderName = `${kanbanFile.basename}_folder`;
  return parentPath ? `${parentPath}/${folderName}` : folderName;
}

export function getBoardFolderPathFromPath(kanbanPath: string) {
  const parts = kanbanPath.split('/');
  const fileName = parts.pop() || '';
  const basename = fileName.replace(/\.md$/i, '');
  const parentPath = parts.join('/');
  const folderName = `${basename}_folder`;
  return parentPath ? `${parentPath}/${folderName}` : folderName;
}

export function getListFolderPath(kanbanFile: TFile, listTitle: string) {
  const listName = sanitizeName(listTitle);
  return `${getBoardFolderPath(kanbanFile)}/${listName}_folder`;
}

export function getListFilePath(kanbanFile: TFile, listTitle: string) {
  const listName = sanitizeName(listTitle);
  return `${getBoardFolderPath(kanbanFile)}/${listName}.md`;
}

export function getListFilePathFromBoardPath(kanbanPath: string, listTitle: string) {
  const listName = sanitizeName(listTitle);
  return `${getBoardFolderPathFromPath(kanbanPath)}/${listName}.md`;
}

export function getCardFilePath(kanbanFile: TFile, listTitle: string, cardTitle: string) {
  const cardName = sanitizeName(cardTitle);
  return `${getListFolderPath(kanbanFile, listTitle)}/${cardName}.md`;
}

export async function ensureFolder(vault: Vault, folderPath: string) {
  const p = normalizePath(folderPath);
  if (vault.getAbstractFileByPath(p)) return;
  try {
    await vault.createFolder(p);
  } catch (e) {
    // Another call may have created it in the meantime.
    if (!(await vault.adapter.exists(p))) throw e;
  }
}

export function buildLink(path: string, alias?: string) {
  if (alias) {
    return `[[${path}|${alias}]]`;
  }
  return `[[${path}]]`;
}

export function buildCardContent(cardPath: string, cardTitle: string, description: string) {
  return buildLink(cardPath, cardTitle);
}

export function extractCardLinkPath(titleRaw: string): string | null {
  const first = titleRaw.split(/\r?\n/)[0]?.trim() ?? '';
  if (first.startsWith('[[')) {
    const trimmed = first.endsWith(']]') ? first.slice(2, -2) : first.slice(2);
    const [path] = trimmed.split('|');
    return path?.trim() || null;
  }
  return null;
}

export function buildCardFilename(cardTitle: string, createdAt: Date) {
  const stamp = createdAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '_');
  return `${sanitizeName(cardTitle)}_file_${stamp}.md`;
}

export async function findCardFilePathInListFile(
  app: App,
  listFilePath: string,
  cardTitle: string
) {
  const listFile = app.vault.getAbstractFileByPath(listFilePath);
  if (!(listFile instanceof TFile)) return null;

  const titleSlug = sanitizeName(cardTitle);
  const linkRe = /\[\[([^\]]+)\]\]/g;
  const content = await app.vault.read(listFile);
  let match: RegExpExecArray | null;

  while ((match = linkRe.exec(content))) {
    const raw = match[1];
    const [linkPath] = raw.split('|');
    const parts = (linkPath || '').split('/');
    const file = parts[parts.length - 1] || '';
    const fileNoExt = file.replace(/\.md$/i, '');

    // Match both _file_ timestamp pattern and exact name match
    if (file.startsWith(`${titleSlug}_file_`) || fileNoExt === titleSlug) {
      // Resolve to full vault path using Obsidian's link resolution
      // (handles short links like [[filename]] that getAbstractFileByPath can't resolve)
      const resolved = app.metadataCache.getFirstLinkpathDest(linkPath, listFilePath);
      if (resolved) return resolved.path;

      // Fallback to raw path if metadata cache can't resolve
      return linkPath.endsWith('.md') ? linkPath : `${linkPath}.md`;
    }
  }

  return null;
}

export async function findCardFilePathInListFolder(
  app: App,
  listFolderPath: string,
  cardTitle: string
) {
  const folder = app.vault.getAbstractFileByPath(listFolderPath);
  if (!folder || !(folder instanceof TFolder)) return null;

  const titleSlug = sanitizeName(cardTitle);
  const children = folder.children || [];
  for (const child of children) {
    if (!child?.name) continue;
    if (child.name.startsWith(`${titleSlug}_file_`)) {
      return child.path;
    }
    if (child.name === `${titleSlug}.md`) {
      return child.path;
    }
  }

  return null;
}

const priorityFieldRegex = /\s*\[priority::\s*[^\]]*\]/g;

export function extractCardTitle(titleRaw: string) {
  const first = titleRaw.split(/\r?\n/)[0]?.trim() ?? '';
  if (first.startsWith('[[')) {
    const trimmed = first.endsWith(']]') ? first.slice(2, -2) : first.slice(2);
    const [path, alias] = trimmed.split('|');
    if (alias) return alias.trim().replace(priorityFieldRegex, '').trim();
    const parts = (path || '').split('/');
    const file = parts[parts.length - 1] || '';
    return file.replace(/\.md$/i, '').trim();
  }

  return first.replace(priorityFieldRegex, '').trim();
}

export function updateCardContentLink(content: string, newPath: string, cardTitle: string) {
  const lines = content.split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  if (first.startsWith('[[')) {
    lines[0] = cardTitle;
    return lines.join('\n');
  }

  return [cardTitle, ...lines.slice(1)].join('\n');
}

export async function addCardLinkToListFile(
  app: App,
  listFilePath: string,
  cardFilePath: string
) {
  const vault = app.vault;
  const link = buildLink(cardFilePath);
  const existing = vault.getAbstractFileByPath(listFilePath);
  const listFile = existing instanceof TFile ? existing : await vault.create(listFilePath, '');
  const content = await vault.read(listFile);

  if (content.includes(link)) return;

  const prefix = content.trim().length ? `${content.trimEnd()}\n` : '';
  await vault.modify(listFile, `${prefix}- ${link}\n`);
}

export async function addBoardLinkToListFile(
  app: App,
  listFilePath: string,
  boardFilePath: string
) {
  const vault = app.vault;
  const boardLink = buildLink(boardFilePath);
  const boardLinkAlt = buildLink(boardFilePath.replace(/\.md$/i, ''));
  const existing = vault.getAbstractFileByPath(listFilePath);
  const listFile = existing instanceof TFile ? existing : await vault.create(listFilePath, '');
  const content = await vault.read(listFile);

  if (content.includes(boardLink) || content.includes(boardLinkAlt)) return;

  const prefix = content.trim().length ? `${content.trimEnd()}\n\n` : '';
  await vault.modify(listFile, `${prefix}${boardLink}\n`);
}

export async function removeCardLinkFromListFile(
  app: App,
  listFilePath: string,
  cardFilePath: string
) {
  const vault = app.vault;
  const listFile = vault.getAbstractFileByPath(listFilePath);
  if (!(listFile instanceof TFile)) return;

  const link = buildLink(cardFilePath);
  const altLink = buildLink(cardFilePath.replace(/\.md$/, ''));
  const lines = (await vault.read(listFile)).split(/\r?\n/);
  const nextLines = lines.filter((line) => !line.includes(link) && !line.includes(altLink));

  if (nextLines.join('\n') !== lines.join('\n')) {
    await vault.modify(listFile, `${nextLines.join('\n').trimEnd()}\n`);
  }
}

/**
 * Last-resort search: find a card file anywhere in the vault by filename pattern.
 * Used when the _folder was moved before the migration fix was applied.
 */
export function findCardFileInVault(app: App, cardTitle: string): string | null {
  const titleSlug = sanitizeName(cardTitle);
  if (!titleSlug) return null;
  const files = app.vault.getFiles();
  for (const f of files) {
    if (f.name.startsWith(`${titleSlug}_file_`)) {
      return f.path;
    }
  }
  return null;
}

/**
 * Find an orphaned board _folder that exists elsewhere in the vault.
 * Returns the old board path (inferred) if an orphaned folder is found.
 */
export function findOrphanedBoardFolder(
  app: App,
  boardFile: TFile
): string | null {
  const expectedFolderPath = getBoardFolderPath(boardFile);
  // If the expected folder already exists, nothing is orphaned
  if (app.vault.getAbstractFileByPath(expectedFolderPath)) return null;

  const folderName = `${boardFile.basename}_folder`;
  const allFiles = app.vault.getAllLoadedFiles();
  for (const f of allFiles) {
    if (f instanceof TFolder && f.name === folderName && f.path !== expectedFolderPath) {
      // Infer what the old board path was based on the orphaned folder's location
      const oldParent = parentDirPath(f);
      return oldParent ? `${oldParent}/${boardFile.name}` : boardFile.name;
    }
  }
  return null;
}

/**
 * After a board file moves to a different directory, migrate the _folder
 * structure and update all internal wiki-links in list files.
 *
 * Handles two scenarios:
 *  1. Board file moved alone — the _folder stays at the old location and needs to be moved.
 *  2. Parent directory moved — the _folder already moved but links inside list files are stale.
 */
export async function migrateBoardFolder(
  app: App,
  boardFile: TFile,
  oldBoardPath: string
) {
  const vault = app.vault;

  const oldParts = oldBoardPath.split('/');
  const oldFileName = oldParts.pop() || '';
  const oldBasename = oldFileName.replace(/\.md$/i, '');
  const oldParent = oldParts.join('/');

  const oldFolderPath = oldParent
    ? `${oldParent}/${oldBasename}_folder`
    : `${oldBasename}_folder`;
  const newFolderPath = getBoardFolderPath(boardFile);

  // If paths are the same (just renamed in place) nothing to migrate
  if (oldFolderPath === newFolderPath) return;

  // Scenario 1: old folder still at old location → move it
  const oldFolder = vault.getAbstractFileByPath(oldFolderPath);
  if (oldFolder && oldFolder instanceof TFolder) {
    try {
      await vault.rename(oldFolder, newFolderPath);
    } catch (e) {
      console.error('[Kanban] Failed to move board folder:', e);
    }
  }

  // Update stale wiki-links inside list files
  const boardFolder = vault.getAbstractFileByPath(newFolderPath);
  if (boardFolder && boardFolder instanceof TFolder) {
    for (const child of boardFolder.children) {
      if (child instanceof TFile && child.extension === 'md') {
        const content = await vault.read(child);
        let updated = content;

        // Replace old folder path prefix with new one in all links
        updated = updated.replaceAll(oldFolderPath, newFolderPath);

        // Update board back-link (with and without .md extension)
        updated = updated.replaceAll(oldBoardPath, boardFile.path);
        const oldBoardNoExt = oldBoardPath.replace(/\.md$/i, '');
        const newBoardNoExt = boardFile.path.replace(/\.md$/i, '');
        updated = updated.replaceAll(oldBoardNoExt, newBoardNoExt);

        if (updated !== content) {
          await vault.modify(child, updated);
        }
      }
    }
  }
}

/**
 * Set or clear `[priority:: x]`. It always goes on the first line: Obsidian
 * only reads task fields from a card's first line, and multi-line (team)
 * cards would otherwise show the raw marker in their description.
 */
export function setPriorityInTitle(titleRaw: string, value: string | null) {
  const lines = titleRaw.split(/\r?\n/).map((l) => l.replace(/\s*\[priority::\s*[^\]]*\]/g, ''));
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  if (value !== null) lines[0] = `${lines[0].trimEnd()} [priority:: ${value}]`;
  return lines.join('\n');
}

/** Description as shown on a board card: tags and inline fields live in the footer/badges instead. */
export function compactCardBody(md: string) {
  return md
    .replace(/(^|[ \t])#[^\s#\]\[)(]+/gm, '$1')
    .replace(/[ \t]*\[[A-Za-z][\w-]*::[^\]]*\]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
