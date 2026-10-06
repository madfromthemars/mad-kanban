import { around } from 'monkey-around';
import {
  App,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  ViewState,
  WorkspaceLeaf,
  debounce,
} from 'obsidian';
import { render, unmountComponentAtNode, useEffect, useState } from 'preact/compat';

import { createApp } from './DragDropApp';
import { KanbanView, kanbanIcon, kanbanViewType } from './KanbanView';
import { KanbanSettings, KanbanSettingsTab } from './Settings';
import { StateManager } from './StateManager';

import { getParentWindow } from './dnd/util/getWindow';
import { hasFrontmatterKey } from './helpers';
import { t } from './lang/helpers';
import { basicFrontmatter, frontmatterKey } from './parsers/common';
import { migrateBoardFolder, parentDirPath } from './kanbanFileHelpers';
import { clearCardCaches } from './components/Item/ItemContent';
import { TeamManager } from './team/TeamManager';
import { PluginUpdater } from './team/PluginUpdater';

interface WindowRegistry {
  viewMap: Map<string, KanbanView>;
  viewStateReceivers: Array<(views: KanbanView[]) => void>;
  appRoot: HTMLElement;
}

function getEditorClass(app: App) {
  const md = app.embedRegistry.embedByExtension.md(
    { app: app, containerEl: createDiv(), state: {} },
    null,
    ''
  );

  md.load();
  md.editable = true;
  md.showEditor();

  const MarkdownEditor = Object.getPrototypeOf(Object.getPrototypeOf(md.editMode)).constructor;

  md.unload();

  return MarkdownEditor;
}

class NewKanbanModal extends Modal {
  defaultValue: string;
  onSubmit: (value: string | null) => void;
  submitted: boolean = false;
  inputEl: HTMLInputElement;

  constructor(app: App, defaultValue: string, onSubmit: (value: string | null) => void) {
    super(app);
    this.defaultValue = defaultValue;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('kanban-plugin__new-board-modal');

    contentEl.createEl('h2', { text: t('New kanban board') });

    this.inputEl = contentEl.createEl('input', {
      type: 'text',
      placeholder: t('Untitled Kanban'),
    });
    this.inputEl.addClass('kanban-plugin__new-board-input');
    this.inputEl.value = this.defaultValue;
    this.inputEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        this.submit();
      }
    });

    const actions = contentEl.createDiv({ cls: 'kanban-plugin__new-board-actions' });
    const createButton = actions.createEl('button', {
      text: t('Create new board'),
      cls: 'mod-cta',
    });
    const cancelButton = actions.createEl('button', { text: t('Cancel') });

    createButton.addEventListener('click', () => this.submit());
    cancelButton.addEventListener('click', () => this.close());

    setTimeout(() => this.inputEl.focus(), 0);
  }

  submit() {
    if (this.submitted) return;
    this.submitted = true;
    this.onSubmit(this.inputEl.value);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.submitted) {
      this.onSubmit(null);
    }
  }
}

export default class KanbanPlugin extends Plugin {
  settingsTab: KanbanSettingsTab;
  settings: KanbanSettings = {};
  team: TeamManager;
  updater: PluginUpdater;

  // leafid => view mode
  kanbanFileModes: Record<string, string> = {};
  stateManagers: Map<TFile, StateManager> = new Map();

  windowRegistry: Map<Window, WindowRegistry> = new Map();

  _loaded: boolean = false;

  isShiftPressed: boolean = false;

  async loadSettings() {
    this.settings = Object.assign({}, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  unload(): void {
    super.unload();
    Promise.all(
      this.app.workspace.getLeavesOfType(kanbanViewType).map((leaf) => {
        this.kanbanFileModes[leaf.id] = 'markdown';
        return this.setMarkdownView(leaf);
      })
    );
  }

  onunload() {
    this.MarkdownEditor = null;
    this.team?.destroy();
    this.updater?.destroy();
    this.windowRegistry.forEach((reg, win) => {
      reg.viewStateReceivers.forEach((fn) => fn([]));
      this.unmount(win);
    });

    this.unmount(window);

    this.stateManagers.clear();
    this.windowRegistry.clear();
    this.kanbanFileModes = {};

    this.app.workspace.unregisterHoverLinkSource(frontmatterKey);
  }

  MarkdownEditor: any;

  async onload() {
    await this.loadSettings();

    this.MarkdownEditor = getEditorClass(this.app);
    this.team = new TeamManager(this);
    void this.team.load();
    this.updater = new PluginUpdater(this);
    this.updater.start();

    this.registerEvent(
      this.app.workspace.on('window-open', (_: unknown, win: Window) => {
        this.mount(win);
      })
    );

    this.registerEvent(
      this.app.workspace.on('window-close', (_: unknown, win: Window) => {
        this.unmount(win);
      })
    );

    this.settingsTab = new KanbanSettingsTab(this, {
      onSettingsChange: async (newSettings) => {
        this.settings = newSettings;
        await this.saveSettings();
        void this.team.configureFromSettings();

        // Force a complete re-render when settings change
        this.stateManagers.forEach((stateManager) => {
          stateManager.forceRefresh();
        });
      },
    });

    this.addSettingTab(this.settingsTab);

    this.registerView(kanbanViewType, (leaf) => new KanbanView(leaf, this));
    this.registerMonkeyPatches();
    this.registerCommands();
    this.registerEvents();

    // Mount an empty component to start; views will be added as we go
    this.mount(window);

    this.app.workspace.floatingSplit?.children?.forEach((c) => {
      this.mount(c.win);
    });

    this.registerDomEvent(window, 'keydown', this.handleShift);
    this.registerDomEvent(window, 'keyup', this.handleShift);

    this.addRibbonIcon(kanbanIcon, t('Create new board'), () => {
      this.newKanban();
    });
  }

  handleShift = (e: KeyboardEvent) => {
    this.isShiftPressed = e.shiftKey;
  };

  getKanbanViews(win: Window) {
    const reg = this.windowRegistry.get(win);

    if (reg) {
      return Array.from(reg.viewMap.values());
    }

    return [];
  }

  getKanbanView(id: string, win: Window) {
    const reg = this.windowRegistry.get(win);

    if (reg?.viewMap.has(id)) {
      return reg.viewMap.get(id);
    }

    for (const reg of this.windowRegistry.values()) {
      if (reg.viewMap.has(id)) {
        return reg.viewMap.get(id);
      }
    }

    return null;
  }

  getStateManager(file: TFile) {
    return this.stateManagers.get(file);
  }

  getStateManagerFromViewID(id: string, win: Window) {
    const view = this.getKanbanView(id, win);

    if (!view) {
      return null;
    }

    return this.stateManagers.get(view.file);
  }

  useKanbanViews(win: Window): KanbanView[] {
    const [state, setState] = useState(this.getKanbanViews(win));

    useEffect(() => {
      const reg = this.windowRegistry.get(win);

      reg?.viewStateReceivers.push(setState);

      return () => {
        reg?.viewStateReceivers.remove(setState);
      };
    }, [win]);

    return state;
  }

  addView(view: KanbanView, data: string, shouldParseData: boolean) {
    const win = view.getWindow();
    const reg = this.windowRegistry.get(win);

    if (!reg) return;
    if (!reg.viewMap.has(view.id)) {
      reg.viewMap.set(view.id, view);
    }

    const file = view.file;

    if (this.stateManagers.has(file)) {
      this.stateManagers.get(file).registerView(view, data, shouldParseData);
    } else {
      this.stateManagers.set(
        file,
        new StateManager(
          this.app,
          view,
          data,
          () => this.stateManagers.delete(file),
          () => this.settings,
          this
        )
      );
    }

    reg.viewStateReceivers.forEach((fn) => fn(this.getKanbanViews(win)));
  }

  removeView(view: KanbanView) {
    const entry = Array.from(this.windowRegistry.entries()).find(([, reg]) => {
      return reg.viewMap.has(view.id);
    }, []);

    if (!entry) return;

    const [win, reg] = entry;
    const file = view.file;

    if (reg.viewMap.has(view.id)) {
      reg.viewMap.delete(view.id);
    }

    if (this.stateManagers.has(file)) {
      this.stateManagers.get(file).unregisterView(view);
      reg.viewStateReceivers.forEach((fn) => fn(this.getKanbanViews(win)));
    }
  }

  handleViewFileRename(view: KanbanView, oldPath: string) {
    const win = view.getWindow();
    if (!this.windowRegistry.has(win)) {
      return;
    }

    const reg = this.windowRegistry.get(win);
    const oldId = `${view.leaf.id}:::${oldPath}`;

    if (reg.viewMap.has(oldId)) {
      reg.viewMap.delete(oldId);
    }

    if (!reg.viewMap.has(view.id)) {
      reg.viewMap.set(view.id, view);
    }

    // Check if the board moved to a different directory
    const oldParent = oldPath.split('/').slice(0, -1).join('/');
    const newParent = parentDirPath(view.file);

    if (oldParent !== newParent) {
      // Clear stale caches immediately
      clearCardCaches();

      // Delay slightly to let Obsidian finish all rename operations,
      // then migrate the _folder structure and update links
      setTimeout(async () => {
        try {
          await migrateBoardFolder(this.app, view.file, oldPath);
        } catch (e) {
          console.error('[Kanban] Board folder migration failed:', e);
          new Notice('Kanban: Board folder migration failed' + (e instanceof Error ? ': ' + e.message : ''));
        }
        if (view.isPrimary) {
          this.getStateManager(view.file).forceRefresh();
        }
      }, 500);
    } else if (view.isPrimary) {
      this.getStateManager(view.file).softRefresh();
    }
  }

  mount(win: Window) {
    if (this.windowRegistry.has(win)) {
      return;
    }

    const el = win.document.body.createDiv();

    this.windowRegistry.set(win, {
      viewMap: new Map(),
      viewStateReceivers: [],
      appRoot: el,
    });

    render(createApp(win, this), el);
  }

  unmount(win: Window) {
    if (!this.windowRegistry.has(win)) {
      return;
    }

    const reg = this.windowRegistry.get(win);

    for (const view of reg.viewMap.values()) {
      this.removeView(view);
    }

    unmountComponentAtNode(reg.appRoot);

    reg.appRoot.remove();
    reg.viewMap.clear();
    reg.viewStateReceivers.length = 0;
    reg.appRoot = null;

    this.windowRegistry.delete(win);
  }

  async setMarkdownView(leaf: WorkspaceLeaf, focus: boolean = true) {
    await leaf.setViewState(
      {
        type: 'markdown',
        state: leaf.view.getState(),
        popstate: true,
      } as ViewState,
      { focus }
    );
  }

  async setKanbanView(leaf: WorkspaceLeaf) {
    await leaf.setViewState({
      type: kanbanViewType,
      state: leaf.view.getState(),
      popstate: true,
    } as ViewState);
  }

  async promptNewKanbanName(): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new NewKanbanModal(this.app, t('Untitled Kanban'), (value) => resolve(value));
      modal.open();
    });
  }

  async newKanban(folder?: TFolder) {
    const targetFolder = folder
      ? folder
      : this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path || '');

    try {
      const requestedName = await this.promptNewKanbanName();
      if (requestedName === null) return;
      const name = requestedName.trim() || t('Untitled Kanban');

      const kanban = await this.app.fileManager.createNewMarkdownFile(
        targetFolder,
        name
      );

      await this.app.vault.modify(kanban, basicFrontmatter);

      const parentPath = parentDirPath(kanban);
      const folderPath = parentPath ? `${parentPath}/${kanban.basename}_folder` : `${kanban.basename}_folder`;
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        await this.app.vault.createFolder(folderPath);
      }
      const tagsFolderPath = `${folderPath}/tags`;
      if (!this.app.vault.getAbstractFileByPath(tagsFolderPath)) {
        await this.app.vault.createFolder(tagsFolderPath);
      }
      await this.app.workspace.getLeaf().setViewState({
        type: kanbanViewType,
        state: { file: kanban.path },
      });
    } catch (e) {
      console.error('Error creating kanban board:', e);
      new Notice('Kanban: Error creating board' + (e instanceof Error ? ': ' + e.message : ''));
    }
  }

  private addOpenAsKanbanMenuItem(menu: Menu, leaf: WorkspaceLeaf, file: TFile) {
    menu.addItem((item) => {
      item
        .setTitle(t('Open as kanban board'))
        .setIcon(kanbanIcon)
        .setSection('pane')
        .onClick(() => {
          this.kanbanFileModes[leaf.id || file.path] = kanbanViewType;
          this.setKanbanView(leaf);
        });
    });
  }

  registerEvents() {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
        if (source === 'link-context-menu') return;

        const fileIsFile = file instanceof TFile;
        const fileIsFolder = file instanceof TFolder;
        const leafIsMarkdown = leaf?.view instanceof MarkdownView;
        const leafIsKanban = leaf?.view instanceof KanbanView;

        // Add a menu item to the folder context menu to create a board
        if (fileIsFolder) {
          menu.addItem((item) => {
            item
              .setSection('action-primary')
              .setTitle(t('New kanban board'))
              .setIcon(kanbanIcon)
              .onClick(() => this.newKanban(file));
          });
          if (this.team?.isConfigured) {
            menu.addItem((item) => {
              item
                .setSection('action-primary')
                .setTitle(t('New team board'))
                .setIcon('lucide-users')
                .onClick(() => this.team.createTeamBoard(file));
            });
          }
          return;
        }

        if (
          !Platform.isMobile &&
          fileIsFile &&
          leaf &&
          source === 'sidebar-context-menu' &&
          hasFrontmatterKey(this.app, file)
        ) {
          const views = this.getKanbanViews(getParentWindow(leaf.view.containerEl));
          let haveKanbanView = false;

          for (const view of views) {
            if (view.file === file) {
              view.onPaneMenu(menu, 'more-options', false);
              haveKanbanView = true;
              break;
            }
          }

          if (!haveKanbanView) {
            this.addOpenAsKanbanMenuItem(menu, leaf, file as TFile);
            return;
          }
        }

        if (
          leafIsMarkdown &&
          fileIsFile &&
          ['more-options', 'pane-more-options', 'tab-header'].includes(source) &&
          hasFrontmatterKey(this.app, file)
        ) {
          this.addOpenAsKanbanMenuItem(menu, leaf, file as TFile);
        }

        if (fileIsFile && leafIsKanban) {
          if (['pane-more-options', 'tab-header'].includes(source)) {
            menu.addItem((item) => {
              item
                .setTitle(t('Open as markdown'))
                .setIcon(kanbanIcon)
                .setSection('pane')
                .onClick(() => {
                  this.kanbanFileModes[leaf.id || file.path] = 'markdown';
                  this.setMarkdownView(leaf);
                });
            });
          }

          if (Platform.isMobile) {
            const stateManager = this.stateManagers.get(file);
            const kanbanView = leaf.view as KanbanView;
            const boardView =
              kanbanView.viewSettings[frontmatterKey] || stateManager.getSetting(frontmatterKey);

            menu
              .addItem((item) => {
                item
                  .setTitle(t('Add a list'))
                  .setIcon('lucide-plus-circle')
                  .setSection('pane')
                  .onClick(() => {
                    kanbanView.emitter.emit('showLaneForm', undefined);
                  });
              })
              .addItem((item) => {
                item
                  .setTitle(t('Archive completed cards'))
                  .setIcon('lucide-archive')
                  .setSection('pane')
                  .onClick(() => {
                    stateManager.archiveCompletedCards();
                  });
              })
              .addItem((item) =>
                item
                  .setTitle(t('View as board'))
                  .setSection('pane')
                  .setIcon('lucide-trello')
                  .setChecked(boardView === 'basic' || boardView === 'board')
                  .onClick(() => kanbanView.setView('board'))
              )
              .addItem((item) =>
                item
                  .setTitle(t('View as table'))
                  .setSection('pane')
                  .setIcon('lucide-table')
                  .setChecked(boardView === 'table')
                  .onClick(() => kanbanView.setView('table'))
              )
              .addItem((item) =>
                item
                  .setTitle(t('View as list'))
                  .setSection('pane')
                  .setIcon('lucide-server')
                  .setChecked(boardView === 'list')
                  .onClick(() => kanbanView.setView('list'))
              )
              .addItem((item) =>
                item
                  .setTitle(t('Open board settings'))
                  .setSection('pane')
                  .setIcon('lucide-settings')
                  .onClick(() => kanbanView.getBoardSettings())
              );
          }
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file: TFile, oldPath: string) => {
        const kanbanLeaves = this.app.workspace.getLeavesOfType(kanbanViewType);

        kanbanLeaves.forEach((leaf: WorkspaceLeaf) => {
          (leaf.view as KanbanView).handleRename(file.path, oldPath);
        });
      })
    );

    const notifyFileChange = debounce(
      (file: TFile) => {
        this.stateManagers.forEach((manager) => {
          if (manager.file !== file) {
            manager.onFileMetadataChange();
          }
        });
      },
      2000,
      true
    );

    this.registerEvent(
      this.app.vault.on('modify', (file: TFile) => {
        if (file instanceof TFile) {
          notifyFileChange(file);
        }
      })
    );

    this.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile) => {
        notifyFileChange(file);
      })
    );

    this.registerEvent(
      this.app.metadataCache.on('dataview:metadata-change', (_: unknown, file: TFile) => {
        notifyFileChange(file);
      })
    );

    this.registerEvent(
      this.app.metadataCache.on('dataview:api-ready', () => {
        this.stateManagers.forEach((manager) => {
          manager.forceRefresh();
        });
      })
    );

    this.app.workspace.registerHoverLinkSource(frontmatterKey, {
      display: 'Kanban',
      defaultMod: true,
    });
  }

  registerCommands() {
    this.addCommand({
      id: 'create-new-kanban-board',
      name: t('Create new board'),
      callback: () => this.newKanban(),
    });

    this.addCommand({
      id: 'create-new-team-board',
      name: t('Create new team board'),
      callback: () => this.team.createTeamBoard(),
    });

    this.addCommand({
      id: 'join-team-board',
      name: t('Open a team board'),
      callback: () => this.team.joinTeamBoard(),
    });

    this.addCommand({
      id: 'check-plugin-updates',
      name: t('Check for plugin updates'),
      callback: () => void this.updater.check(true),
    });

    this.addCommand({
      id: 'refresh-team-boards',
      name: t('Refresh team boards'),
      callback: () => {
        this.team.syncs.forEach((s) => void s.load());
        this.team.mirrors.forEach((m) => m.requestRefresh(0));
      },
    });

    this.addCommand({
      id: 'archive-completed-cards',
      name: t('Archive completed cards in active board'),
      checkCallback: (checking) => {
        const activeView = this.app.workspace.getActiveViewOfType(KanbanView);

        if (!activeView) return false;
        if (checking) return true;

        this.stateManagers.get(activeView.file).archiveCompletedCards();
      },
    });

    this.addCommand({
      id: 'toggle-kanban-view',
      name: t('Toggle between Kanban and markdown mode'),
      checkCallback: (checking) => {
        const activeFile = this.app.workspace.getActiveFile();

        if (!activeFile) return false;

        const fileCache = this.app.metadataCache.getFileCache(activeFile);
        const fileIsKanban = !!fileCache?.frontmatter && !!fileCache.frontmatter[frontmatterKey];

        if (checking) {
          return fileIsKanban;
        }

        const activeView = this.app.workspace.getActiveViewOfType(KanbanView);

        if (activeView) {
          this.kanbanFileModes[activeView.leaf.id || activeFile.path] = 'markdown';
          this.setMarkdownView(activeView.leaf);
        } else if (fileIsKanban) {
          const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

          if (activeView) {
            this.kanbanFileModes[activeView.leaf.id || activeFile.path] = kanbanViewType;
            this.setKanbanView(activeView.leaf);
          }
        }
      },
    });

    this.addCommand({
      id: 'convert-to-kanban',
      name: t('Convert empty note to Kanban'),
      checkCallback: (checking) => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

        if (!activeView) return false;

        const isFileEmpty = activeView.file.stat.size === 0;

        if (checking) return isFileEmpty;
        if (isFileEmpty) {
          this.app.vault
            .modify(activeView.file, basicFrontmatter)
            .then(() => {
              this.setKanbanView(activeView.leaf);
            })
            .catch((e: Error) => { console.error(e); new Notice('Kanban: Error converting note' + (e instanceof Error ? ': ' + e.message : '')); });
        }
      },
    });

    this.addCommand({
      id: 'add-kanban-lane',
      name: t('Add a list'),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.emitter.emit('showLaneForm', undefined);
        }
      },
    });

    this.addCommand({
      id: 'view-board',
      name: t('View as board'),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.setView('board');
        }
      },
    });

    this.addCommand({
      id: 'view-table',
      name: t('View as table'),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.setView('table');
        }
      },
    });

    this.addCommand({
      id: 'view-list',
      name: t('View as list'),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.setView('list');
        }
      },
    });

    this.addCommand({
      id: 'open-board-settings',
      name: t('Open board settings'),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);

        if (!view) return false;
        if (checking) return true;

        view.getBoardSettings();
      },
    });
  }

  registerMonkeyPatches() {
    const self = this;

    this.app.workspace.onLayoutReady(() => {
      this.register(
        around(this.app.commands, {
          executeCommand(next) {
            return function (command: { id: string }) {
              const view = self.app.workspace.getActiveViewOfType(KanbanView);

              if (view && command?.id) {
                view.emitter.emit('hotkey', { commandId: command.id });
              }

              return next.call(this, command);
            };
          },
        })
      );
    });

    this.register(
      around(this.app.workspace, {
        setActiveLeaf(next) {
          return function (...args) {
            next.apply(this, args);
            const view = this.getActiveViewOfType(KanbanView);
            if (view?.activeEditor) {
              this.activeEditor = view.activeEditor;
            }
          };
        },
      })
    );

    // Monkey patch WorkspaceLeaf to open Kanbans with KanbanView by default
    this.register(
      around(WorkspaceLeaf.prototype, {
        // Kanbans can be viewed as markdown or kanban, and we keep track of the mode
        // while the file is open. When the file closes, we no longer need to keep track of it.
        detach(next) {
          return function () {
            const state = this.view?.getState();

            if (state?.file && self.kanbanFileModes[this.id || state.file]) {
              delete self.kanbanFileModes[this.id || state.file];
            }

            return next.apply(this);
          };
        },

        setViewState(next) {
          return function (state: ViewState, ...rest: any[]) {
            const filePath = state.state?.file as string | undefined;
            if (
              // Don't force kanban mode during shutdown
              self._loaded &&
              // If we have a markdown file
              state.type === 'markdown' &&
              filePath &&
              // And the current mode of the file is not set to markdown
              self.kanbanFileModes[this.id || filePath] !== 'markdown'
            ) {
              // Then check for the kanban frontMatterKey
              const cache = self.app.metadataCache.getCache(filePath);

              if (cache?.frontmatter && cache.frontmatter[frontmatterKey]) {
                // If we have it, force the view type to kanban
                const newState = {
                  ...state,
                  type: kanbanViewType,
                };

                self.kanbanFileModes[filePath] = kanbanViewType;

                return next.apply(this, [newState, ...rest]);
              }
            }

            return next.apply(this, [state, ...rest]);
          };
        },
      })
    );
  }
}
