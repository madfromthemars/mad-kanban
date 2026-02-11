import { App, TFile, TFolder, Vault } from 'obsidian';

const illegalCharsRegEx = /[\\/:"*?<>|]+/g;
const condenceWhiteSpaceRE = /\s+/g;

export function sanitizeName(rawTitle: string) {
  return rawTitle
    .replace(illegalCharsRegEx, ' ')
    .trim()
    .replace(condenceWhiteSpaceRE, ' ')
    .replace(/[. ]+$/g, '');
}

export function getBoardFolderPath(kanbanFile: TFile) {
  const parentPath = kanbanFile.parent?.path || '';
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
  if (!vault.getAbstractFileByPath(folderPath)) {
    await vault.createFolder(folderPath);
  }
}

export function buildLink(path: string, alias?: string) {
  if (alias) {
    return `[[${path}|${alias}]]`;
  }
  return `[[${path}]]`;
}

export function buildCardContent(cardPath: string, cardTitle: string, description: string) {
  return cardTitle.trim();
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
    const [path] = raw.split('|');
    const parts = (path || '').split('/');
    const file = parts[parts.length - 1] || '';
    if (file.startsWith(`${titleSlug}_file_`)) {
      return path.endsWith('.md') ? path : `${path}.md`;
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

export function extractCardTitle(titleRaw: string) {
  const first = titleRaw.split(/\r?\n/)[0]?.trim() ?? '';
  if (first.startsWith('[[')) {
    const trimmed = first.endsWith(']]') ? first.slice(2, -2) : first.slice(2);
    const [path, alias] = trimmed.split('|');
    if (alias) return alias.trim();
    const parts = (path || '').split('/');
    const file = parts[parts.length - 1] || '';
    return file.replace(/\.md$/i, '').trim();
  }

  return first;
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
