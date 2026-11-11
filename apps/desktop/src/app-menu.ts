/**
 * The application menu. Without one Electron installs its default, whose items (Reload, Toggle Developer Tools, a
 * "Help" pointing at electronjs.org) are wrong for a packaged app.
 */
import type { MenuItemConstructorOptions } from "electron";

/** What a menu item asks the page to do. The site maps each to its own route or dialog. */
export const MENU_COMMANDS = ["new-chat", "settings"] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export interface AppMenuOptions {
    appName: string;
    /** Reload and the developer tools are for a dev run only: in a release they would reload away a streaming reply. */
    isPackaged: boolean;
    onCommand: (command: MenuCommand) => void;
    /** Omitted, the Help menu is left out. */
    onOpenDocumentation?: () => void;
    platform: NodeJS.Platform;
}

const separator: MenuItemConstructorOptions = { type: "separator" };

export const buildAppMenuTemplate = ({ appName, isPackaged, onCommand, onOpenDocumentation, platform }: AppMenuOptions): MenuItemConstructorOptions[] => {
    const isMac = platform === "darwin";
    const settings: MenuItemConstructorOptions = { accelerator: "CmdOrCtrl+,", click: () => onCommand("settings"), label: "Settings…" };
    const template: MenuItemConstructorOptions[] = [];

    if (isMac) {
        template.push({
            label: appName,
            submenu: [
                { role: "about" },
                separator,
                settings,
                separator,
                { role: "services" },
                separator,
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                separator,
                { role: "quit" },
            ],
        });
    }

    template.push(
        {
            label: "File",
            submenu: [
                { accelerator: "CmdOrCtrl+N", click: () => onCommand("new-chat"), label: "New Chat" },
                separator,
                // Elsewhere there is no app menu, so Settings and Quit live here.
                ...isMac ? [{ role: "close" } as const] : [settings, separator, { role: "close" } as const, { role: "quit" } as const],
            ],
        },
        {
            label: "Edit",
            submenu: [
                { role: "undo" },
                { role: "redo" },
                separator,
                { role: "cut" },
                { role: "copy" },
                { role: "paste" },
                { role: "pasteAndMatchStyle" },
                { role: "delete" },
                separator,
                { role: "selectAll" },
            ],
        },
        {
            label: "View",
            submenu: [
                ...isPackaged ? [] : [{ role: "reload" } as const, { role: "forceReload" } as const, { role: "toggleDevTools" } as const, separator],
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                separator,
                { role: "togglefullscreen" },
            ],
        },
        {
            // `role: "window"` lets macOS list the open windows in it.
            role: "window",
            submenu: [{ role: "minimize" }, { role: "zoom" }, ...isMac ? [separator, { role: "front" } as const] : [{ role: "close" } as const]],
        },
    );

    if (onOpenDocumentation !== undefined) {
        template.push({ role: "help", submenu: [{ click: () => onOpenDocumentation(), label: `${appName} Documentation` }] });
    }

    return template;
};
