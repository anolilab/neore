import { getPlatformModifierForEvents } from "@neore/ui/utils/keyboard-shortcuts";

import convertShortcutToHotkeysHook from "./shortcut-converter";

/**
 * The same conversion for a command whose binding is recorded in the settings: the recorder stores
 * Control and Command alike as `ctrl` and the settings page shows it as the platform's key (⌘ on a
 * Mac), so on a Mac the registration answers to Command as well as to Control. Elsewhere it is
 * {@link convertShortcutToHotkeysHook} unchanged.
 */
export const convertRecordedShortcutToHotkeysHook = (
    shortcut: string | undefined,
    platformModifier: "cmd" | "ctrl" = getPlatformModifierForEvents(),
): string => {
    const converted = convertShortcutToHotkeysHook(shortcut);

    if (platformModifier !== "cmd" || !shortcut?.trim() || !converted.split("+").slice(0, -1).includes("ctrl")) {
        return converted;
    }

    const withCommand = converted
        .split("+")
        .map((part, index, parts) => (part === "ctrl" && index < parts.length - 1 ? "meta" : part))
        .join("+");

    return `${converted},${withCommand}`;
};
