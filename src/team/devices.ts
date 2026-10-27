import { App, Platform } from 'obsidian';

import type { TeamDevice } from './types';

export type DevicePlatform = TeamDevice['platform'];

export function devicePlatform(): DevicePlatform {
  if (Platform.isIosApp) return 'ios';
  if (Platform.isAndroidApp) return 'android';
  if (Platform.isMacOS) return 'mac';
  if (Platform.isWin) return 'windows';
  if (Platform.isLinux) return 'linux';
  return '';
}

/** A readable default name, e.g. "iPhone · Work" or "Mac · MADHause". */
export function defaultDeviceName(app: App): string {
  const kind = Platform.isIosApp
    ? Platform.isTablet
      ? 'iPad'
      : 'iPhone'
    : Platform.isAndroidApp
      ? Platform.isTablet
        ? 'Android tablet'
        : 'Android phone'
      : Platform.isMacOS
        ? 'Mac'
        : Platform.isWin
          ? 'Windows PC'
          : Platform.isLinux
            ? 'Linux PC'
            : 'Device';
  const vault = app.vault.getName?.() || '';
  return vault ? `${kind} · ${vault}` : kind;
}

export const PLATFORM_LABEL: Record<string, string> = {
  ios: 'iPhone / iPad',
  android: 'Android',
  mac: 'Mac',
  windows: 'Windows',
  linux: 'Linux',
  '': 'Device',
};

export const PLATFORM_ICON: Record<string, string> = {
  ios: 'lucide-smartphone',
  android: 'lucide-smartphone',
  mac: 'lucide-laptop',
  windows: 'lucide-monitor',
  linux: 'lucide-monitor',
  '': 'lucide-monitor-smartphone',
};

export const deviceIcon = (d: { platform: string; kind?: string }) =>
  d.kind === 'ai' ? 'lucide-bot' : PLATFORM_ICON[d.platform] || PLATFORM_ICON[''];
export const deviceLabel = (d: { platform: string; kind?: string }) =>
  d.kind === 'ai' ? 'AI key' : PLATFORM_LABEL[d.platform] || 'Device';

export function lastSeenText(ts: number, current?: boolean): string {
  if (current) return 'This device';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 2) return 'Active now';
  if (mins < 60) return `Active ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Active ${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `Active ${days} day${days === 1 ? '' : 's'} ago`;
  return `Last active ${new Date(ts).toLocaleDateString()}`;
}

/**
 * What this install remembers about itself, outside the vault. A vault folder copied to
 * another device carries data.json (client id and device key) but not this, which is how
 * a copy is told apart from the original.
 */
export interface DeviceMarker {
  clientId: string;
  deviceId?: string | null;
}

const MARKER_KEY = 'mad-kanban-device';

type LocalStorageApp = App & {
  loadLocalStorage?: (key: string) => unknown;
  saveLocalStorage?: (key: string, value: unknown) => void;
  appId?: string;
};

export function loadDeviceMarker(app: App): DeviceMarker | null {
  const a = app as LocalStorageApp;
  try {
    const raw = a.loadLocalStorage
      ? a.loadLocalStorage(MARKER_KEY)
      : window.localStorage.getItem(`${a.appId || ''}-${MARKER_KEY}`);
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && typeof v === 'object' && typeof (v as DeviceMarker).clientId === 'string' ? (v as DeviceMarker) : null;
  } catch {
    return null;
  }
}

export function saveDeviceMarker(app: App, marker: DeviceMarker) {
  const a = app as LocalStorageApp;
  const value = JSON.stringify(marker);
  try {
    if (a.saveLocalStorage) a.saveLocalStorage(MARKER_KEY, value);
    else window.localStorage.setItem(`${a.appId || ''}-${MARKER_KEY}`, value);
  } catch {
    /* ignore: worst case this install mints one extra device key later */
  }
}
