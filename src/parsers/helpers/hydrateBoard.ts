import { moment } from 'obsidian';
import { StateManager } from 'src/StateManager';
import { c, escapeRegExpStr } from 'src/components/helpers';
import { Board, DataTypes, Item, Lane } from 'src/components/types';
import { Path } from 'src/dnd/types';
import { getEntityFromPath } from 'src/dnd/util/data';
import { Op } from 'src/helpers/patch';

import { getSearchValue } from '../common';

export function hydrateLane(stateManager: StateManager, lane: Lane) {
  return lane;
}

export function preprocessTitle(stateManager: StateManager, title: string) {
  const dateTrigger = stateManager.getSetting('date-trigger');
  const dateFormat = stateManager.getSetting('date-format');

  const { app } = stateManager;

  let date: moment.Moment;

  title = title.replace(
    new RegExp(`(^|\\s)${escapeRegExpStr(dateTrigger)}\\[\\[([^\\]]+)\\]\\]`, 'g'),
    (match, space, content) => {
      const parsed = moment(content, dateFormat);
      if (!parsed.isValid()) return match;
      date = parsed;
      const linkPath = app.metadataCache.getFirstLinkpathDest(content, stateManager.file.path);
      return `${space}<a class="internal-link" data-href="${linkPath?.path ?? content}" href="${linkPath?.path ?? content}" target="_blank" rel="noopener">${parsed.format(dateFormat)}</a>`;
    }
  );
  title = title.replace(
    new RegExp(`(^|\\s)${escapeRegExpStr(dateTrigger)}\\[([^\\]]+)\\]\\([^)]+\\)`, 'g'),
    (match, space, content) => {
      const parsed = moment(content, dateFormat);
      if (!parsed.isValid()) return match;
      date = parsed;
      const linkPath = app.metadataCache.getFirstLinkpathDest(content, stateManager.file.path);
      return `${space}<a class="internal-link" data-href="${linkPath?.path ?? content}" href="${linkPath?.path ?? content}" target="_blank" rel="noopener">${parsed.format(dateFormat)}</a>`;
    }
  );
  title = title.replace(
    new RegExp(`(^|\\s)${escapeRegExpStr(dateTrigger)}{([^}]+)}`, 'g'),
    (match, space, content) => {
      const parsed = moment(content, dateFormat);
      if (!parsed.isValid()) return match;
      date = parsed;
      return `${space}${parsed.format(dateFormat)}`;
    }
  );

  return title;
}

export function hydrateItem(stateManager: StateManager, item: Item) {
  const { dateStr, timeStr, fileAccessor } = item.data.metadata;

  if (dateStr) {
    item.data.metadata.date = moment(dateStr, stateManager.getSetting('date-format'));
  }

  if (timeStr) {
    let time = moment(timeStr, 'HH:mm');

    if (item.data.metadata.date) {
      const date = item.data.metadata.date;

      date.hour(time.hour());
      date.minute(time.minute());
      date.second(time.second());

      time = date.clone();
    }

    item.data.metadata.time = time;
  }

  if (fileAccessor) {
    const file = stateManager.app.metadataCache.getFirstLinkpathDest(
      fileAccessor.target,
      stateManager.file.path
    );

    if (file) {
      item.data.metadata.file = file;
    }
  }

  item.data.titleSearch = getSearchValue(item, stateManager);

  return item;
}

export function hydrateBoard(stateManager: StateManager, board: Board): Board {
  try {
    board.children.map((lane) => {
      hydrateLane(stateManager, lane);
      lane.children.map((item) => {
        return hydrateItem(stateManager, item);
      });
    });
  } catch (e) {
    stateManager.setError(e);
    throw e;
  }

  return board;
}

function opAffectsHydration(op: Op) {
  return (
    (op.op === 'add' || op.op === 'replace') &&
    ['title', 'titleRaw', 'dateStr', 'timeStr', /\d$/, /\/fileAccessor\/.+$/].some((postFix) => {
      if (typeof postFix === 'string') {
        return op.path.last().toString().endsWith(postFix);
      } else {
        return postFix.test(op.path.last().toString());
      }
    })
  );
}

export function hydratePostOp(stateManager: StateManager, board: Board, ops: Op[]): Board {
  const seen: Record<string, boolean> = {};
  const toHydrate = ops.reduce((paths, op) => {
    if (!opAffectsHydration(op)) {
      return paths;
    }

    const path = op.path.reduce((path, segment) => {
      if (typeof segment === 'number') {
        path.push(segment);
      }

      return path;
    }, [] as Path);

    const key = path.join(',');

    if (!seen[key]) {
      seen[key] = true;
      paths.push(path);
    }

    return paths;
  }, [] as Path[]);

  toHydrate.map((path) => {
    const entity = getEntityFromPath(board, path);

    if (entity.type === DataTypes.Lane) {
      return hydrateLane(stateManager, entity);
    }

    if (entity.type === DataTypes.Item) {
      return hydrateItem(stateManager, entity);
    }
  });

  return board;
}
