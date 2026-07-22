/**
 * Obsidian internal API augmentations.
 * These are undocumented APIs accessed throughout the plugin.
 */
import 'obsidian';

declare module 'obsidian' {
  interface App {
    plugins: {
      enabledPlugins: Set<string>;
      plugins: Record<
        string,
        | { api?: Record<string, (...args: any[]) => any>; [key: string]: any }
        | undefined
      >;
    };
    internalPlugins: {
      plugins: Record<
        string,
        { instance?: Record<string, (...args: any[]) => any>; [key: string]: any }
      >;
      getPluginById(
        id: string
      ): { instance?: Record<string, (...args: any[]) => any> } | undefined;
    };
    commands: {
      executeCommand(command: { id: string }): void;
    };
    embedRegistry: {
      embedByExtension: Record<
        string,
        (
          ctx: { app: App; containerEl: HTMLElement; state: Record<string, unknown> },
          file: null,
          subpath: string
        ) => ObsidianEmbed
      >;
    };
    dragManager: {
      draggable: {
        type: string;
        file?: TFile;
        files?: TFile[];
        linktext?: string;
        [key: string]: any;
      } | null;
    };
    mobileToolbar?: { update(): void };
    mobileNavbar?: { containerEl: HTMLElement };
  }

  interface ObsidianEmbed {
    load(): void;
    unload(): void;
    editable: boolean;
    showEditor(): void;
    editMode: { constructor: new (...args: unknown[]) => unknown };
  }

  interface Workspace {
    registerHoverLinkSource(
      id: string,
      config: { display: string; defaultMod: boolean }
    ): void;
    unregisterHoverLinkSource(id: string): void;
    floatingSplit?: { children?: Array<{ win: Window }> };
    activeEditor: unknown;
    handleLinkContextMenu(menu: Menu, href: string, filePath: string): void;
    handleExternalLinkContextMenu(menu: Menu, href: string): void;
    setActiveLeaf(leaf: WorkspaceLeaf, ...args: unknown[]): void;
  }

  interface WorkspaceLeaf {
    id: string;
  }

  interface Vault {
    getConfig(key: string): unknown;
    config: Record<string, unknown>;
    getAvailablePathForAttachments(
      fileName: string,
      ext: string,
      file: TFile
    ): Promise<string>;
    adapter: DataAdapter & { basePath?: string };
  }

  interface FileManager {
    createNewMarkdownFile(folder: TFolder, name: string): Promise<TFile>;
  }

  interface MetadataCache {
    on(name: 'dataview:metadata-change', callback: (type: unknown, file: TFile) => void): EventRef;
    on(name: 'dataview:api-ready', callback: () => void): EventRef;
  }

  interface Menu {
    addSections(sections: string[]): void;
  }

  interface MenuItem {
    setSubmenu(): Menu;
  }
}

declare global {
  interface Window {
    CodeMirrorAdapter?: {
      Vim?: {
        enterInsertMode(cm: unknown): void;
      };
    };
  }
}

/**
 * Micromark type augmentations.
 * Widen TokenTypeMap to accept custom token names used by our parser extensions.
 */
declare module 'micromark-util-types' {
  interface TokenTypeMap {
    hashtag: 'hashtag';
    hashtagMarker: 'hashtagMarker';
    hashtagData: 'hashtagData';
    hashtagTarget: 'hashtagTarget';
    blockid: 'blockid';
    blockidMarker: 'blockidMarker';
    blockidData: 'blockidData';
    blockidTarget: 'blockidTarget';
    date: 'date';
    dateMarker: 'dateMarker';
    dateData: 'dateData';
    dateTarget: 'dateTarget';
    time: 'time';
    timeMarker: 'timeMarker';
    timeData: 'timeData';
    timeTarget: 'timeTarget';
    file: 'file';
    fileMarker: 'fileMarker';
    fileData: 'fileData';
    fileTarget: 'fileTarget';
    taskListCheck: 'taskListCheck';
    taskListCheckMarker: 'taskListCheckMarker';
    taskListCheckValueUnchecked: 'taskListCheckValueUnchecked';
    taskListCheckValueChecked: 'taskListCheckValueChecked';
  }
}
