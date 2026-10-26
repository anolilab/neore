/**
 * "Start at login" for the tray menu. Only a packaged build on macOS or Windows
 * can register a login item: a dev run would register the Electron binary, and
 * Linux has no `setLoginItemSettings` (it is a no-op there).
 */

export interface LoginItemMenuState {
    checked: boolean;
    enabled: boolean;
}

export const supportsLoginItem = (platform: NodeJS.Platform): boolean => platform === "darwin" || platform === "win32";

/** The menu item's state from what the OS says. `openAtLogin` is ignored when the item is unavailable. */
export const loginItemMenuState = ({
    isPackaged,
    openAtLogin,
    platform,
}: {
    isPackaged: boolean;
    openAtLogin: boolean;
    platform: NodeJS.Platform;
}): LoginItemMenuState => {
    const enabled = isPackaged && supportsLoginItem(platform);

    return { checked: enabled && openAtLogin, enabled };
};
