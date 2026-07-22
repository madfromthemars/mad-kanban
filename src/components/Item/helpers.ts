import { FileWithPath, fromEvent } from 'file-selector';
import { DataAdapter, Platform, TFile, TFolder, htmlToMarkdown, moment, parseLinktext, setIcon } from 'obsidian';
import { StateManager } from 'src/StateManager';
import { Path } from 'src/dnd/types';
import { Priority, getTaskStatusDone } from 'src/parsers/helpers/inlineMetadata';

import { BoardModifiers } from '../../helpers/boardModifiers';
import { c, escapeRegExpStr } from '../helpers';
import { Item } from '../types';

const priorityClassMap: Record<string, string> = {
  [Priority.Highest]: 'priority-highest',
  [Priority.High]: 'priority-high',
  [Priority.Medium]: 'priority-medium',
  [Priority.Low]: 'priority-low',
};

export function getItemClassModifiers(item: Item) {
  const classModifiers: string[] = [];

  if (item.data.checked && item.data.checkChar === getTaskStatusDone()) {
    classModifiers.push('is-complete');
  }

  for (const tag of item.data.metadata.tags) {
    classModifiers.push(`has-tag-${tag.slice(1)}`);
  }

  const priority = item.data.metadata.priority;
  if (priority && priorityClassMap[priority]) {
    classModifiers.push(priorityClassMap[priority]);
  }

  return classModifiers;
}

export function linkTo(
  stateManager: StateManager,
  file: TFile,
  sourcePath: string,
  subpath?: string
) {
  // Generate a link relative to this Kanban board, respecting user link type preferences
  return stateManager.app.fileManager.generateMarkdownLink(file, sourcePath, subpath);
}

export function getMarkdown(html: string) {
  return htmlToMarkdown(html);
}

export function fixLinks(text: string) {
  // Internal links from e.g. dataview plugin incorrectly begin with `app://obsidian.md/`, and
  // we also want to remove bullet points and task markers from text and markdown
  return text.replace(/^\[(.*)\]\(app:\/\/obsidian.md\/(.*)\)$/, '[$1]($2)');
}

interface FileData {
  buffer: ArrayBuffer;
  mimeType: string;
  originalName: string;
}

function readClipboardImage(clipboard: any): FileData[] | null {
  const clipboardImage = clipboard.readImage('clipboard');
  if (clipboardImage.isEmpty()) return null;
  const png = clipboardImage.toPNG();
  return [
    {
      buffer: png,
      mimeType: 'image/png',
      originalName: `Pasted image ${moment().format('YYYYMMDDHHmmss')}.png`,
    },
  ];
}

export function getFileListFromClipboard(win: Window & typeof globalThis) {
  const clipboard = win.require('electron').remote.clipboard;

  if (process.platform === 'darwin') {
    // https://github.com/electron/electron/issues/9035#issuecomment-359554116
    if (clipboard.has('NSFilenamesPboardType')) {
      return (
        (clipboard.read('NSFilenamesPboardType') as string)
          .match(/<string>.*<\/string>/g)
          ?.map((item) => item.replace(/<string>|<\/string>/g, '')) || []
      );
    }

    return (
      readClipboardImage(clipboard) ||
      [(clipboard.read('public.file-url') as string).replace('file://', '')].filter(
        (item) => item
      )
    );
  } else {
    // https://github.com/electron/electron/issues/9035#issuecomment-536135202
    // https://docs.microsoft.com/en-us/windows/win32/shell/clipboard#cf_hdrop
    // https://www.codeproject.com/Reference/1091137/Windows-Clipboard-Formats
    if (clipboard.has('CF_HDROP')) {
      const rawFilePathStr = clipboard.read('CF_HDROP') || '';
      let formatFilePathStr = [...rawFilePathStr]
        .filter((_, index) => rawFilePathStr.charCodeAt(index) !== 0)
        .join('')
        .replace(/\\/g, '\\');

      const drivePrefix = formatFilePathStr.match(/[a-zA-Z]:\\/);

      if (drivePrefix) {
        const drivePrefixIndex = formatFilePathStr.indexOf(drivePrefix[0]);
        if (drivePrefixIndex !== 0) {
          formatFilePathStr = formatFilePathStr.slice(drivePrefixIndex);
        }
        return formatFilePathStr
          .split(drivePrefix[0])
          .filter((item) => item)
          .map((item) => drivePrefix + item);
      }
    }

    return (
      readClipboardImage(clipboard) ||
      [
        (clipboard.readBuffer('FileNameW').toString('ucs2') as string).replace(
          RegExp(String.fromCharCode(0), 'g'),
          ''
        ),
      ].filter((item) => item)
    );
  }
}

function getFileFromPath(file: string) {
  return file.split('\\').pop().split('/').pop();
}

async function linkFromBuffer(
  stateManager: StateManager,
  fileName: string,
  ext: string,
  buffer: ArrayBuffer
) {
  const path = await stateManager.app.vault.getAvailablePathForAttachments(
    fileName,
    ext,
    stateManager.file
  );

  const newFile = await stateManager.app.vault.createBinary(path, buffer);

  return linkTo(stateManager, newFile, stateManager.file.path);
}

async function handleElectronPaste(stateManager: StateManager, win: Window & typeof globalThis) {
  const list = getFileListFromClipboard(win);

  if (!list || list.length === 0) return null;

  const fs = win.require('fs/promises');
  const nPath = win.require('path');

  return (
    await Promise.all(
      list.map(async (file) => {
        if (typeof file === 'string') {
          const fileStr = getFileFromPath(file);

          const splitFile = fileStr.split('.');
          const ext = splitFile.pop();
          const fileName = splitFile.join('.');

          const path = await stateManager.app.vault.getAvailablePathForAttachments(
            fileName,
            ext,
            stateManager.file
          );

          const basePath = (stateManager.app.vault.adapter as DataAdapter & { basePath?: string }).basePath;

          await fs.copyFile(file, nPath.join(basePath, path));

          // Wait for Obsidian to update
          await new Promise((resolve) => win.setTimeout(resolve, 50));

          const newFile = stateManager.app.vault.getAbstractFileByPath(path) as TFile;

          return linkTo(stateManager, newFile, stateManager.file.path);
        } else {
          const splitFile = file.originalName.split('.');
          const ext = splitFile.pop();
          const fileName = splitFile.join('.');

          return await linkFromBuffer(stateManager, fileName, ext, file.buffer);
        }
      })
    )
  ).filter((file) => file);
}

function handleFiles(stateManager: StateManager, files: FileWithPath[], isPaste?: boolean) {
  return Promise.all(
    files.map((file) => {
      const splitFileName = file.name.split('.');

      let ext = splitFileName.pop();
      let fileName = splitFileName.join('.');

      if (isPaste) {
        switch (file.type) {
          case 'text/jpg':
            ext = 'jpg';
            break;
          case 'text/jpeg':
            ext = 'jpeg';
            break;
          case 'text/png':
            ext = 'png';
            break;
        }

        fileName = 'Pasted image ' + moment().format('YYYYMMDDHHmmss');
      }

      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            const path = await stateManager.app.vault.getAvailablePathForAttachments(
              fileName,
              ext,
              stateManager.file
            );
            const newFile = await stateManager.app.vault.createBinary(
              path,
              e.target.result as ArrayBuffer
            );

            resolve(linkTo(stateManager, newFile, stateManager.file.path));
          } catch (e) {
            console.error(e);
            reject(e);
          }
        };
        reader.readAsArrayBuffer(file as FileWithPath);
      });
    })
  );
}

async function handleNullDraggable(
  stateManager: StateManager,
  e: DragEvent | ClipboardEvent,
  win: Window & typeof globalThis
) {
  const isClipboardEvent = (e as DragEvent).view ? false : true;
  const forcePlaintext = isClipboardEvent ? stateManager.getAView().isShiftPressed : false;
  const transfer = isClipboardEvent
    ? (e as ClipboardEvent).clipboardData
    : (e as DragEvent).dataTransfer;
  const clipboard =
    isClipboardEvent && Platform.isDesktopApp ? win.require('electron').remote.clipboard : null;
  const formats = clipboard ? clipboard.availableFormats() : [];

  if (!isClipboardEvent) {
    const files = await fromEvent(e);
    if (files.length) {
      return await handleFiles(stateManager, files as FileWithPath[]);
    }
  } else if (isClipboardEvent && !forcePlaintext && !formats.includes('text/rtf')) {
    if (Platform.isDesktopApp) {
      const links = await handleElectronPaste(stateManager, win);

      if (links?.length) {
        return links;
      }
    }

    const files: File[] = [];
    const items = (e as ClipboardEvent).clipboardData.items;

    for (const index in items) {
      const item = items[index];
      if (item.kind === 'file') {
        files.push(item.getAsFile());
      }
    }

    if (files.length) {
      return await handleFiles(stateManager, files, true);
    }
  }

  const html = transfer.getData('text/html');
  const plain = transfer.getData('text/plain');
  const uris = transfer.getData('text/uri-list');

  const text = forcePlaintext ? plain || html : getMarkdown(html);

  return [fixLinks(text || uris || plain || html || '').trim()];
}

export async function handleDragOrPaste(
  stateManager: StateManager,
  e: DragEvent | ClipboardEvent,
  win: Window & typeof globalThis
): Promise<string[]> {
  const draggable = stateManager.app.dragManager.draggable;
  const transfer = (e as DragEvent).view
    ? (e as DragEvent).dataTransfer
    : (e as ClipboardEvent).clipboardData;

  switch (draggable?.type) {
    case 'file':
      return [linkTo(stateManager, draggable.file, stateManager.file.path)];
    case 'files':
      return draggable.files.map((f: TFile) => linkTo(stateManager, f, stateManager.file.path));
    case 'folder': {
      return draggable.file.children
        .map((f: TFile | TFolder) => {
          if (f instanceof TFolder) {
            return null;
          }

          return linkTo(stateManager, f, stateManager.file.path);
        })
        .filter((link: string | null) => link);
    }
    case 'link': {
      let link = draggable.file
        ? linkTo(stateManager, draggable.file, parseLinktext(draggable.linktext).subpath)
        : `[[${draggable.linktext}]]`;
      const alias = new DOMParser().parseFromString(transfer.getData('text/html'), 'text/html')
        .documentElement.textContent; // Get raw text
      link = link.replace(/]]$/, `|${alias}]]`).replace(/^\[[^\]].+]\(/, `[${alias}](`);
      return [link];
    }
    default: {
      return await handleNullDraggable(stateManager, e, win);
    }
  }
}
