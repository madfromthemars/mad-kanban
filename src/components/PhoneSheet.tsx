import { createPortal, useEffect } from 'preact/compat';

import { Icon } from './Icon/Icon';
import { c } from './helpers';

/**
 * Phone bottom sheet: dims the screen and slides a panel up from the bottom. Rendered on
 * <body> so it sits above Obsidian's bottom bar and above the card window.
 */
export function PhoneSheet({
  title,
  onClose,
  onBack,
  action,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  /** Shows a back arrow (sub-page of the sheet). */
  onBack?: () => void;
  /** Text button on the right of the header, e.g. "Clear". */
  action?: { label: string; onClick: () => void } | null;
  footer?: any;
  children?: any;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onBack ? onBack() : onClose();
      }
    };
    activeDocument.addEventListener('keydown', onKey, true);
    return () => activeDocument.removeEventListener('keydown', onKey, true);
  }, [onBack, onClose]);

  return createPortal(
    <div
      className={c('sheet-backdrop')}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className={c('sheet')} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className={c('sheet-grabber')} />
        <div className={c('sheet-head')}>
          {onBack ? (
            <button className={c('sheet-icon-button')} aria-label="Back" onClick={onBack}>
              <Icon name="lucide-chevron-left" />
            </button>
          ) : (
            <span className={c('sheet-head-spacer')} />
          )}
          <span className={c('sheet-title')}>{title}</span>
          {action ? (
            <a className={c('sheet-action')} onClick={action.onClick}>
              {action.label}
            </a>
          ) : (
            <span className={c('sheet-head-spacer')} />
          )}
        </div>
        <div className={c('sheet-body')}>{children}</div>
        {footer && <div className={c('sheet-foot')}>{footer}</div>}
      </div>
    </div>,
    activeDocument.body
  );
}

/** One tappable row of a sheet list: optional leading icon, label, trailing value/check/chevron. */
export function SheetRow({
  icon,
  label,
  value,
  checked,
  chevron,
  danger,
  onClick,
}: {
  icon?: any;
  label: any;
  value?: any;
  checked?: boolean;
  chevron?: boolean;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className={`${c('sheet-row')} ${checked ? 'is-checked' : ''} ${danger ? 'is-danger' : ''}`} onClick={onClick}>
      {icon !== undefined && <span className={c('sheet-row-icon')}>{icon}</span>}
      <span className={c('sheet-row-label')}>{label}</span>
      {value !== undefined && <span className={c('sheet-row-value')}>{value}</span>}
      {checked !== undefined && (
        <span className={c('sheet-row-check')}>{checked && <Icon name="lucide-check" />}</span>
      )}
      {chevron && <Icon name="lucide-chevron-right" className={c('sheet-row-chevron')} />}
    </button>
  );
}

/** A row with an on/off switch. */
export function SheetSwitch({ label, icon, on, onChange }: { label: string; icon?: any; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button className={c('sheet-row')} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      {icon !== undefined && <span className={c('sheet-row-icon')}>{icon}</span>}
      <span className={c('sheet-row-label')}>{label}</span>
      <span className={`${c('sheet-switch')} ${on ? 'is-on' : ''}`} />
    </button>
  );
}
