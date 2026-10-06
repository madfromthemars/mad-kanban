import update from 'immutability-helper';
import { Menu, Notice, Platform, TFolder } from 'obsidian';
import { Dispatch, StateUpdater, useCallback } from 'preact/hooks';
import { StateManager } from 'src/StateManager';
import { Path } from 'src/dnd/types';
import { moveEntity } from 'src/dnd/util/data';
import { t } from 'src/lang/helpers';

import { BoardModifiers } from '../../helpers/boardModifiers';
import { parseTeamItemId } from 'src/team/ids';
import { setPriorityInTitle } from 'src/kanbanFileHelpers';
import { AssigneeModal } from 'src/team/ui/modals';
import { applyTemplate, escapeRegExpStr, generateInstanceId } from '../helpers';
import { EditState, Item } from '../types';

const illegalCharsRegEx = /[\\/:"*?<>|]+/g;
const embedRegEx = /!?\[\[([^\]]*)\.[^\]]+\]\]/g;
const wikilinkRegEx = /!?\[\[([^\]]*)\]\]/g;
const mdLinkRegEx = /!?\[([^\]]*)\]\([^)]*\)/g;
const tagRegEx = /#([^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s\n\r]+)/g;
const condenceWhiteSpaceRE = /\s+/g;

interface UseItemMenuParams {
  setEditState: Dispatch<StateUpdater<EditState>>;
  item: Item;
  path: Path;
  boardModifiers: BoardModifiers;
  stateManager: StateManager;
}

export function useItemMenu({
  setEditState,
  item,
  path,
  boardModifiers,
  stateManager,
}: UseItemMenuParams) {
  return useCallback(
    (e: MouseEvent) => {
      const coordinates = { x: e.clientX, y: e.clientY };
      const teamInfo = parseTeamItemId(item.id);
      const team = stateManager.plugin?.team;
      const isTeam = !!teamInfo && !!team;
      const isMirror = isTeam && !stateManager.teamSync;

      const menu = new Menu().addItem((i) => {
        i.setIcon('lucide-edit')
          .setTitle(t('Edit card'))
          .onClick(() => setEditState(coordinates));
      });

      if (isTeam) {
        menu.addItem((i) => {
          i.setIcon('lucide-user-plus')
            .setTitle(t('Assign to...'))
            .onClick(() => {
              const assignees = team.getCard(teamInfo.cardId)?.assignees || [];
              new AssigneeModal(stateManager.app, team.users, assignees, (user) => {
                void team.toggleAssignee(teamInfo.boardId, teamInfo.cardId, user.id);
              }).open();
            });
        });
      }

      if (isMirror) {
        menu.addItem((i) => {
          i.setIcon('lucide-users')
            .setTitle(t('Open team board'))
            .onClick(() => void team.openBoard(teamInfo.boardId));
        });
      }

      if (!isMirror) menu
        .addItem((i) => {
          i.setIcon('lucide-file-plus-2')
            .setTitle(t('New note from card'))
            .onClick(async () => {
              const prevTitle = item.data.titleRaw.split('\n')[0].trim();
              const sanitizedTitle = prevTitle
                .replace(embedRegEx, '$1')
                .replace(wikilinkRegEx, '$1')
                .replace(mdLinkRegEx, '$1')
                .replace(tagRegEx, '$1')
                .replace(illegalCharsRegEx, ' ')
                .trim()
                .replace(condenceWhiteSpaceRE, ' ');

              const newNoteFolder = stateManager.getSetting('new-note-folder');
              const newNoteTemplatePath = stateManager.getSetting('new-note-template');

              const targetFolder = newNoteFolder
                ? (stateManager.app.vault.getAbstractFileByPath(newNoteFolder as string) as TFolder)
                : stateManager.app.fileManager.getNewFileParent(stateManager.file.path);

              const newFile = await stateManager.app.fileManager.createNewMarkdownFile(
                targetFolder,
                sanitizedTitle
              );

              const newLeaf = stateManager.app.workspace.splitActiveLeaf();

              await newLeaf.openFile(newFile);

              stateManager.app.workspace.setActiveLeaf(newLeaf, false, true);

              await applyTemplate(stateManager, newNoteTemplatePath as string | undefined);

              const newTitleRaw = item.data.titleRaw.replace(
                prevTitle,
                stateManager.app.fileManager.generateMarkdownLink(newFile, stateManager.file.path)
              );

              boardModifiers.updateItem(path, stateManager.updateItemContent(item, newTitleRaw));
            });
        })
        .addItem((i) => {
          i.setIcon('lucide-link')
            .setTitle(t('Copy link to card'))
            .onClick(() => {
              if (item.data.blockId) {
                navigator.clipboard.writeText(
                  `${stateManager.app.fileManager.generateMarkdownLink(
                    stateManager.file,
                    '',
                    '#^' + item.data.blockId
                  )}`
                );
              } else {
                const id = generateInstanceId(6);

                navigator.clipboard.writeText(
                  `${stateManager.app.fileManager.generateMarkdownLink(stateManager.file, '', '#^' + id)}`
                );

                boardModifiers.updateItem(
                  path,
                  stateManager.updateItemContent(
                    update(item, { data: { blockId: { $set: id } } }),
                    item.data.titleRaw
                  )
                );
              }
            });
        });

      try {
        const currentPriority = item.data.metadata.priority;

        const priorityOptions: { label: string; value: string | null }[] = [
          { label: '🔺 Highest', value: '0' },
          { label: '⏫ High', value: '1' },
          { label: '🔼 Medium', value: '2' },
          { label: '🔽 Low', value: '4' },
          { label: 'None', value: null },
        ];

        const addPriorityOptions = (targetMenu: Menu) => {
          for (const opt of priorityOptions) {
            targetMenu.addItem((mi) => {
              mi.setTitle(opt.label);
              const isChecked =
                opt.value === null
                  ? !currentPriority || currentPriority === '3'
                  : currentPriority === opt.value;
              mi.setChecked(isChecked);
              mi.onClick(() => {
                const newTitleRaw = setPriorityInTitle(item.data.titleRaw, opt.value);
                boardModifiers.updateItem(
                  path,
                  stateManager.updateItemContent(item, newTitleRaw)
                );
              });
            });
          }
        };

        if (Platform.isPhone) {
          addPriorityOptions(menu);
        } else {
          menu.addItem((mi) => {
            const submenu = mi
              .setTitle('Set priority')
              .setIcon('lucide-signal')
              .setSubmenu();

            addPriorityOptions(submenu);
          });
        }
      } catch (e) {
        console.error('Kanban: Error building priority menu', e);
        new Notice('Kanban: Error building menu' + (e instanceof Error ? ': ' + e.message : ''));
      }

      menu.addSeparator();

      if (isMirror) {
        menu
          .addItem((i) => {
            i.setIcon('lucide-arrow-up')
              .setTitle(t('Move to top'))
              .onClick(() => boardModifiers.moveItemToTop(path));
          })
          .addItem((i) => {
            i.setIcon('lucide-arrow-down')
              .setTitle(t('Move to bottom'))
              .onClick(() => boardModifiers.moveItemToBottom(path));
          })
          .addItem((i) => {
            i.setIcon('lucide-user-minus')
              .setTitle(t('Remove from my board'))
              .onClick(() => boardModifiers.deleteEntity(path));
          })
          .addSeparator();
      }

      if (!isMirror && /\n/.test(item.data.titleRaw)) {
        menu.addItem((i) => {
          i.setIcon('lucide-wrap-text')
            .setTitle(t('Split card'))
            .onClick(async () => {
              const titles = item.data.titleRaw.split(/[\r\n]+/g).map((t) => t.trim());
              const newItems = await Promise.all(
                titles.map((title) => {
                  return stateManager.getNewItem(title, ' ');
                })
              );

              boardModifiers.splitItem(path, newItems);
            });
        });
      }

      if (!isMirror) menu
        .addItem((i) => {
          i.setIcon('lucide-copy')
            .setTitle(t('Duplicate card'))
            .onClick(() => boardModifiers.duplicateEntity(path));
        })
        .addItem((i) => {
          i.setIcon('lucide-list-start')
            .setTitle(t('Insert card before'))
            .onClick(() =>
              boardModifiers.insertItems(path, [stateManager.getNewItem('', ' ', true)])
            );
        })
        .addItem((i) => {
          i.setIcon('lucide-list-end')
            .setTitle(t('Insert card after'))
            .onClick(() => {
              const newPath = [...path];

              newPath[newPath.length - 1] = newPath[newPath.length - 1] + 1;

              boardModifiers.insertItems(newPath, [stateManager.getNewItem('', ' ', true)]);
            });
        })
        .addItem((i) => {
          i.setIcon('lucide-arrow-up')
            .setTitle(t('Move to top'))
            .onClick(() => boardModifiers.moveItemToTop(path));
        })
        .addItem((i) => {
          i.setIcon('lucide-arrow-down')
            .setTitle(t('Move to bottom'))
            .onClick(() => boardModifiers.moveItemToBottom(path));
        })
        .addItem((i) => {
          i.setIcon('lucide-archive')
            .setTitle(t('Archive card'))
            .onClick(() => boardModifiers.archiveItem(path));
        })
        .addItem((i) => {
          i.setIcon('lucide-trash-2')
            .setTitle(t('Delete card'))
            .onClick(() => boardModifiers.deleteEntity(path));
        })
        .addSeparator();

      const addMoveToOptions = (menu: Menu) => {
        const lanes = stateManager.state.children;
        if (lanes.length <= 1) return;
        for (let i = 0, len = lanes.length; i < len; i++) {
          menu.addItem((item) =>
            item
              .setIcon('lucide-square-kanban')
              .setChecked(path[0] === i)
              .setTitle(lanes[i].data.title)
              .onClick(() => {
                if (path[0] === i) return;
                stateManager.setState((boardData) => {
                  return moveEntity(boardData, path, [i, 0]);
                });
              })
          );
        }
      };

      if (Platform.isPhone) {
        addMoveToOptions(menu);
      } else {
        menu.addItem((item) => {
          const submenu = item
            .setTitle(t('Move to list'))
            .setIcon('lucide-square-kanban')
            .setSubmenu();

          addMoveToOptions(submenu);
        });
      }

      menu.showAtPosition(coordinates);
    },
    [setEditState, item, path, boardModifiers, stateManager]
  );
}
