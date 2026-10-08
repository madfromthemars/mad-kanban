import { App, Modal, Notice, Setting } from 'obsidian';
import { useContext } from 'preact/compat';
import { StateManager } from 'src/StateManager';
import { getEntityFromPath } from 'src/dnd/util/data';
import { Path } from 'src/dnd/types';
import { BoardModifiers } from 'src/helpers/boardModifiers';
import { isTeamItem, parseTeamItemId } from 'src/team/ids';

import { Icon } from './Icon/Icon';
import { KanbanContext } from './context';
import { c } from './helpers';
import { extractCardTitle } from 'src/kanbanFileHelpers';
import { DataTypes, Item } from './types';

export const TRASH_ZONE = 'trash-zone';

class ConfirmDeleteModal extends Modal {
  constructor(app: App, private title: string, private onConfirm: () => void) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('Delete card?');
    this.contentEl.createEl('p', { text: `"${this.title}" will be deleted. This can't be undone.` });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText('Delete')
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Cards mirrored from a team board live on the team board; act on it there. */
async function teamCardOp(stateManager: StateManager, item: Item, type: 'card.delete') {
  const team = stateManager.plugin?.team;
  const ids = parseTeamItemId(item.id);
  if (!team || !ids) return false;
  try {
    const res = await team.client.applyOps(ids.boardId, [{ type, id: ids.cardId } as any]);
    if (!res.ok) throw new Error(res.results.find((r: any) => !r.ok)?.error || 'rejected');
    team.mirrors.forEach((m) => m.requestRefresh(0));
    return true;
  } catch (e) {
    new Notice(`Kanban: could not delete the card (${e?.message || e})`);
    stateManager.plugin?.reportError('zone.' + type, e);
    return false;
  }
}

const isMirrored = (stateManager: StateManager, item: Item) => isTeamItem(item) && !stateManager.teamSync;

/** A card was dropped on the Delete zone: confirm, then delete. */
export function deleteDroppedCard(stateManager: StateManager, modifiers: BoardModifiers, path: Path) {
  const item = getEntityFromPath(stateManager.state, path) as Item;
  if (!item || item.type !== DataTypes.Item) return;
  const title = extractCardTitle(item.data.titleRaw) || 'this card';
  new ConfirmDeleteModal(stateManager.app, title, () => {
    if (isMirrored(stateManager, item)) {
      void teamCardOp(stateManager, item, 'card.delete');
      return;
    }
    // The card may have moved while the dialog was open; find it again by id.
    const board = stateManager.state;
    for (let l = 0; l < board.children.length; l++) {
      const i = board.children[l].children.findIndex((it) => it.id === item.id);
      if (i >= 0) {
        modifiers.deleteEntity([l, i]);
        return;
      }
    }
  }).open();
}

/** Floating drop target shown at the bottom of the board while a card is dragged. */
export function TrashZone() {
  const { stateManager } = useContext(KanbanContext);
  return (
    <div
      className={c('trash-float')}
      data-kanban-zone={TRASH_ZONE}
      data-kanban-zone-file={stateManager.file.path}
    >
      <Icon name="lucide-trash-2" />
      <span>Drop here to delete</span>
    </div>
  );
}
