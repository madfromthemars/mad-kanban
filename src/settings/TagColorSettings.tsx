import { colord } from 'colord';
import update from 'immutability-helper';
import {
  render,
  unmountComponentAtNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/compat';

import { Icon } from '../components/Icon/Icon';
import { c, generateInstanceId } from '../components/helpers';
import { TagColor, TagColorSetting, TagColorSettingTemplate } from '../components/types';
import { getParentBodyElement } from '../dnd/util/getWindow';
import { t } from '../lang/helpers';

interface ItemProps {
  defaultColors: { color: string; backgroundColor: string };
  deleteKey: () => void;
  tagColorKey: TagColor;
  updateKey: (tagKey: string, color: string, backgroundColor: string) => void;
}

export function colorToRgbaString(color: string) {
  const parsed = colord(color);

  if (!parsed.isValid()) {
    return null;
  }

  const rgba = parsed.toRgb();
  return {
    rgba: `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a})`,
    hexa: parsed.toHex(),
  };
}

export interface ColorPickerInputProps {
  color?: string;
  setColor: (color: string) => void;
  defaultColor: string;
}

export function ColorPickerInput({ color, setColor, defaultColor }: ColorPickerInputProps) {
  const parsed = colord(color || defaultColor);
  const rgba = parsed.isValid() ? parsed.toRgb() : { r: 0, g: 0, b: 0, a: 1 };
  const [localHEX, setLocalHEX] = useState(parsed.isValid() ? parsed.toHex() : '#000000');
  const [localAlpha, setLocalAlpha] = useState(rgba.a);
  const wrapperRef = useRef<HTMLDivElement>();
  const [isPickerVisible, setIsPickerVisible] = useState(false);

  const applyColor = useCallback(
    (hex: string, alpha: number) => {
      const c = colord(hex).alpha(alpha);
      if (c.isValid()) {
        const rgb = c.toRgb();
        setColor(`rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${rgb.a})`);
      }
    },
    [setColor]
  );

  useEffect(() => {
    if (!color || !defaultColor) return;
    const normalized = colord(color || defaultColor);
    if (normalized.isValid()) {
      setLocalHEX(normalized.toHex().slice(0, 7));
      setLocalAlpha(normalized.toRgb().a);
    }
  }, []);

  useEffect(() => {
    if (!isPickerVisible) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsPickerVisible(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isPickerVisible]);

  return (
    <div ref={wrapperRef} className={c('color-picker-wrapper')}>
      {isPickerVisible && (
        <div className={c('color-picker')}>
          <input
            type="color"
            value={localHEX.slice(0, 7)}
            className={c('color-input-native')}
            onInput={(e) => {
              const hex = (e.target as HTMLInputElement).value;
              setLocalHEX(hex);
              applyColor(hex, localAlpha);
            }}
          />
          <div className={c('color-alpha-wrapper')}>
            <label>Opacity</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={localAlpha}
              className={c('color-alpha-slider')}
              onInput={(e) => {
                const alpha = parseFloat((e.target as HTMLInputElement).value);
                setLocalAlpha(alpha);
                applyColor(localHEX, alpha);
              }}
            />
          </div>
        </div>
      )}
      <input
        type="text"
        value={localHEX}
        onChange={(e) => {
          const val = (e.target as HTMLInputElement).value;
          const normalized = colorToRgbaString(val || defaultColor);
          if (normalized) {
            setLocalHEX(normalized.hexa);
            setLocalAlpha(colord(normalized.rgba).toRgb().a);
            setColor(normalized.rgba);
          }
        }}
        onFocus={() => {
          setIsPickerVisible(true);
        }}
      />
    </div>
  );
}

function Item({ tagColorKey, deleteKey, updateKey, defaultColors }: ItemProps) {
  return (
    <div className={c('setting-item-wrapper')}>
      <div className={c('setting-item')}>
        <div className={`${c('setting-controls-wrapper')} ${c('tag-color-input')}`}>
          <div className={c('setting-input-wrapper')}>
            <div>
              <div className={c('setting-item-label')}>{t('Tag')}</div>
              <input
                type="text"
                placeholder="#tag"
                value={tagColorKey.tagKey}
                onChange={(e) => {
                  const val = e.currentTarget.value;
                  updateKey(
                    val[0] === '#' ? val : '#' + val,
                    tagColorKey.color,
                    tagColorKey.backgroundColor
                  );
                }}
              />
            </div>
            <div>
              <div className={c('setting-item-label')}>{t('Background color')}</div>
              <ColorPickerInput
                color={tagColorKey.backgroundColor}
                setColor={(color) => {
                  updateKey(tagColorKey.tagKey, tagColorKey.color, color);
                }}
                defaultColor={defaultColors.backgroundColor}
              />
            </div>
            <div>
              <div className={c('setting-item-label')}>{t('Text color')}</div>
              <ColorPickerInput
                color={tagColorKey.color}
                setColor={(color) => {
                  updateKey(tagColorKey.tagKey, color, tagColorKey.backgroundColor);
                }}
                defaultColor={defaultColors.color}
              />
            </div>
          </div>
          <div className={c('setting-toggle-wrapper')}>
            <div>
              <div className={c('item-tags')}>
                <a className={`tag ${c('item-tag')}`}>#tag1</a>
                <a
                  className={`tag ${c('item-tag')}`}
                  style={{
                    '--tag-color': tagColorKey.color,
                    '--tag-background': tagColorKey.backgroundColor,
                  }}
                >
                  {tagColorKey.tagKey || '#tag'}
                </a>
                <a className={`tag ${c('item-tag')}`}>#tag2</a>
              </div>
            </div>
          </div>
        </div>
        <div className={c('setting-button-wrapper')}>
          <div className="clickable-icon" onClick={deleteKey} aria-label={t('Delete')}>
            <Icon name="lucide-trash-2" />
          </div>
        </div>
      </div>
    </div>
  );
}

interface TagSettingsProps {
  dataKeys: TagColorSetting[];
  onChange: (settings: TagColorSetting[]) => void;
  portalContainer: HTMLElement;
}

function TagSettings({ dataKeys, onChange }: TagSettingsProps) {
  const [keys, setKeys] = useState(dataKeys);
  const defaultColors = useMemo(() => {
    const wrapper = createDiv(c('item-tags'));
    const tag = wrapper.createEl('a', c('item-tag'));

    wrapper.style.position = 'absolute';
    wrapper.style.visibility = 'hidden';

    activeDocument.body.append(wrapper);

    const props = activeWindow.getComputedStyle(tag);
    const color = props.getPropertyValue('color').trim();
    const backgroundColor = props.getPropertyValue('background-color').trim();

    wrapper.remove();

    return {
      color,
      backgroundColor,
    };
  }, []);

  const updateKeys = (keys: TagColorSetting[]) => {
    onChange(keys);
    setKeys(keys);
  };

  const newKey = () => {
    updateKeys(
      update(keys, {
        $push: [
          {
            ...TagColorSettingTemplate,
            id: generateInstanceId(),
            data: {
              tagKey: '',
              color: '',
              backgroundColor: '',
            },
          },
        ],
      })
    );
  };

  const deleteKey = (i: number) => {
    updateKeys(
      update(keys, {
        $splice: [[i, 1]],
      })
    );
  };

  const updateTagColor =
    (i: number) => (tagKey: string, color: string, backgroundColor: string) => {
      updateKeys(
        update(keys, {
          [i]: {
            data: {
              tagKey: {
                $set: tagKey,
              },
              color: {
                $set: color,
              },
              backgroundColor: {
                $set: backgroundColor,
              },
            },
          },
        })
      );
    };

  return (
    <div className={c('tag-color-input-wrapper')}>
      <div className="setting-item-info">
        <div className="setting-item-name">{t('Tag colors')}</div>
        <div className="setting-item-description">
          {t('Set colors for tags displayed in cards.')}
        </div>
      </div>
      <div>
        {keys.map((key, index) => (
          <Item
            key={key.id}
            tagColorKey={key.data}
            deleteKey={() => deleteKey(index)}
            updateKey={updateTagColor(index)}
            defaultColors={defaultColors}
          />
        ))}
      </div>
      <button
        className={c('add-tag-color-button')}
        onClick={() => {
          newKey();
        }}
      >
        {t('Add tag color')}
      </button>
    </div>
  );
}

export function renderTagSettings(
  containerEl: HTMLElement,
  keys: TagColorSetting[],
  onChange: (key: TagColorSetting[]) => void
) {
  render(
    <TagSettings
      dataKeys={keys}
      onChange={onChange}
      portalContainer={getParentBodyElement(containerEl)}
    />,
    containerEl
  );
}

export function cleanUpTagSettings(containerEl: HTMLElement) {
  unmountComponentAtNode(containerEl);
}
