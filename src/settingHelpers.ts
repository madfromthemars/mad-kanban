import update from 'immutability-helper';
import { App, Setting, TFile, TFolder, Vault } from 'obsidian';

import { KanbanSettings, SettingsManager } from './Settings';
import { getTemplatePlugins } from './components/helpers';
import { t } from './lang/helpers';

export const defaultMetadataPosition = 'body';

export interface SelectChoice {
  value: string;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  placeholder?: boolean;
}

export function getFolderChoices(app: App) {
  const folderList: SelectChoice[] = [];

  Vault.recurseChildren(app.vault.getRoot(), (f) => {
    if (f instanceof TFolder) {
      folderList.push({
        value: f.path,
        label: f.path,
        selected: false,
        disabled: false,
      });
    }
  });

  return folderList;
}

export function getTemplateChoices(app: App, folderStr?: string) {
  const fileList: SelectChoice[] = [];

  let folder = folderStr ? app.vault.getAbstractFileByPath(folderStr) : null;

  if (!folder || !(folder instanceof TFolder)) {
    folder = app.vault.getRoot();
  }

  Vault.recurseChildren(folder as TFolder, (f) => {
    if (f instanceof TFile) {
      fileList.push({
        value: f.path,
        label: f.basename,
        selected: false,
        disabled: false,
      });
    }
  });

  return fileList;
}

export function getListOptions(app: App) {
  const { templateFolder, templatesEnabled, templaterPlugin } = getTemplatePlugins(app);

  const templateFiles = getTemplateChoices(app, templateFolder);
  const vaultFolders = getFolderChoices(app);

  let templateWarning = '';

  if (!templatesEnabled && !templaterPlugin) {
    templateWarning = t('Note: No template plugins are currently enabled.');
  }

  return {
    templateFiles,
    vaultFolders,
    templateWarning,
  };
}

interface CreateSearchSelectParams {
  choices: SelectChoice[];
  key: keyof KanbanSettings;
  warningText?: string;
  local: boolean;
  placeHolderStr: string;
  manager: SettingsManager;
}

export function createSearchSelect({
  choices,
  key,
  warningText,
  local,
  placeHolderStr,
  manager,
}: CreateSearchSelectParams) {
  return (setting: Setting) => {
    const wrapper = setting.controlEl.createDiv({ cls: 'kanban-search-select' });

    const [value, globalValue] = manager.getSetting(key, local);

    let list = choices;

    let didSetPlaceholder = false;
    if (globalValue) {
      const index = list.findIndex((f) => f.value === globalValue);

      if (index > -1) {
        didSetPlaceholder = true;
        const choice = choices[index];

        list = update(list, {
          $splice: [[index, 1]],
          $unshift: [
            update(choice, {
              placeholder: {
                $set: true,
              },
              value: {
                $set: '',
              },
              label: {
                $apply: (v) => `${v} (${t('default')})`,
              },
            }),
          ],
        });
      }
    }

    if (!didSetPlaceholder) {
      list = update(list, {
        $unshift: [
          {
            placeholder: true,
            value: '',
            label: placeHolderStr,
            selected: false,
            disabled: false,
          },
        ],
      });
    }

    // Only show search input if the list is long enough
    const showSearch = list.length > 10;
    let searchInput: HTMLInputElement | null = null;

    if (showSearch) {
      searchInput = wrapper.createEl('input', {
        type: 'text',
        placeholder: t('Search...'),
        cls: 'kanban-search-select-input',
      });
    }

    const selectEl = wrapper.createEl('select', {
      cls: 'dropdown kanban-search-select-dropdown',
    });

    function populateOptions(filter?: string) {
      selectEl.empty();
      const lowerFilter = filter?.toLocaleLowerCase() || '';

      for (const item of list) {
        if (lowerFilter && !item.label.toLocaleLowerCase().contains(lowerFilter)) {
          continue;
        }
        const opt = selectEl.createEl('option', {
          text: item.label,
          value: item.value,
        });
        if (item.disabled) opt.disabled = true;
      }

      // Restore selection after filtering
      const currentValue = typeof value === 'string' ? value : '';
      if (currentValue && list.findIndex((f) => f.value === currentValue) > -1) {
        selectEl.value = currentValue;
      } else {
        selectEl.value = '';
      }
    }

    populateOptions();

    // Set the current value
    if (value && typeof value === 'string' && list.findIndex((f) => f.value === value) > -1) {
      selectEl.value = value;
    }

    if (searchInput) {
      const onInput = () => populateOptions(searchInput.value);
      searchInput.addEventListener('input', onInput);
      manager.cleanupFns.push(() => searchInput.removeEventListener('input', onInput));
    }

    const onChange = () => {
      const val = selectEl.value;

      if (val) {
        manager.applySettingsUpdate({
          [key]: {
            $set: val,
          },
        });
      } else {
        manager.applySettingsUpdate({
          $unset: [key],
        });
      }
    };

    selectEl.addEventListener('change', onChange);

    manager.cleanupFns.push(() => {
      selectEl.removeEventListener('change', onChange);
    });

    if (warningText) {
      setting.descEl.createDiv({}, (div) => {
        div.createEl('strong', { text: warningText });
      });
    }
  };
}
