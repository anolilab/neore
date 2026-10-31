import type { KeyboardShortcuts } from "@/features/layout/stores/ui-state-store";

export type ShortcutGroupId = "chat" | "composer" | "navigation" | "threadList";

/** Either a user-bindable action (shown with the user's current chord) or a key that is fixed in code. */
export type ShortcutEntry = { action: keyof KeyboardShortcuts; group: ShortcutGroupId; id: string } | { fixed: string; group: ShortcutGroupId; id: string };

export const SHORTCUT_GROUP_ORDER: ReadonlyArray<ShortcutGroupId> = ["navigation", "chat", "composer", "threadList"];

export const SHORTCUT_ENTRIES: ReadonlyArray<ShortcutEntry> = [
    { action: "commandPalette", group: "navigation", id: "commandPalette" },
    { action: "help", group: "navigation", id: "help" },
    { fixed: "?", group: "navigation", id: "helpKey" },
    { action: "sidebarLeft", group: "navigation", id: "sidebarLeft" },
    { action: "sidebarRight", group: "navigation", id: "sidebarRight" },
    { action: "focusSearch", group: "navigation", id: "focusSearch" },
    { action: "firstItem", group: "navigation", id: "firstItem" },
    { action: "lastItem", group: "navigation", id: "lastItem" },
    { action: "prevItem", group: "navigation", id: "prevItem" },
    { action: "nextItem", group: "navigation", id: "nextItem" },
    { action: "escape", group: "navigation", id: "escape" },
    { action: "newChat", group: "chat", id: "newChat" },
    { action: "newTemporaryChat", group: "chat", id: "newTemporaryChat" },
    { action: "findInThread", group: "chat", id: "findInThread" },
    { action: "openModelPicker", group: "chat", id: "openModelPicker" },
    { action: "copyLastCodeBlock", group: "chat", id: "copyLastCodeBlock" },
    { action: "audioRecord", group: "composer", id: "audioRecord" },
    { action: "increaseEffort", group: "composer", id: "increaseEffort" },
    { action: "decreaseEffort", group: "composer", id: "decreaseEffort" },
    { fixed: "arrowup+arrowdown", group: "threadList", id: "listNavigate" },
    { fixed: "enter", group: "threadList", id: "listOpen" },
    { fixed: "ctrl+a", group: "threadList", id: "listSelectAll" },
    { fixed: "escape", group: "threadList", id: "listCancel" },
];

const MODIFIERS = new Set(["alt", "cmd", "ctrl", "meta", "shift"]);

const NAMED_KEYS: Record<string, string> = {
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    backspace: "⌫",
    delete: "Del",
    end: "End",
    enter: "Enter",
    escape: "Esc",
    home: "Home",
    pagedown: "PgDn",
    pageup: "PgUp",
    space: "Space",
    tab: "Tab",
};

const formatKey = (part: string, isMac: boolean): string => {
    const key = part.trim().toLowerCase();

    switch (key) {
        case "alt": {
            return isMac ? "⌥" : "Alt";
        }
        case "cmd":
        case "meta": {
            return isMac ? "⌘" : "Meta";
        }
        // The store keeps the platform modifier as "ctrl"; it is Command on a Mac.
        case "ctrl": {
            return isMac ? "⌘" : "Ctrl";
        }
        case "shift": {
            return isMac ? "⇧" : "Shift";
        }
        default: {
            return NAMED_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : part.trim());
        }
    }
};

// "ctrl+shift+f" as separate keycaps, ⌘ ⇧ F on a Mac and Ctrl Shift F elsewhere. Empty for an unbound chord.
export const shortcutToKeys = (shortcut: string | undefined, isMac: boolean): string[] => {
    if (!shortcut) {
        return [];
    }

    const parts = shortcut.split("+");

    // "ctrl+/" and "ctrl++" end in the key itself; a trailing empty part is the plus key.
    if (parts.length > 1 && parts.at(-1) === "") {
        parts.splice(-2, 2, "+");
    }

    // Modifiers first, in the order platforms print them.
    const modifiers = parts.filter((part) => MODIFIERS.has(part.toLowerCase()));
    const keys = parts.filter((part) => !MODIFIERS.has(part.toLowerCase()));
    const order = ["ctrl", "meta", "cmd", "alt", "shift"];
    const sorted = modifiers.toSorted((a, b) => order.indexOf(a.toLowerCase()) - order.indexOf(b.toLowerCase()));

    return [...sorted, ...keys].map((part) => formatKey(part, isMac));
};

export type ResolvedShortcut = { entry: ShortcutEntry; keys: string[] };

/** Entries with the keys the user has now; actions without a binding are left out. */
export const resolveShortcuts = (bindings: Partial<KeyboardShortcuts>, isMac: boolean): ResolvedShortcut[] =>
    SHORTCUT_ENTRIES.map((entry) => {
        return {
            entry,
            keys: shortcutToKeys("action" in entry ? bindings[entry.action] : entry.fixed, isMac),
        };
    }).filter((resolved) => resolved.keys.length > 0);

/** Case-insensitive match on the label, the group name or the keys as printed. An empty query matches everything. */
export const matchesShortcutQuery = (query: string, label: string, groupLabel: string, keys: ReadonlyArray<string>): boolean => {
    const needle = query.trim().toLowerCase();

    if (!needle) {
        return true;
    }

    return [label, groupLabel, keys.join(" "), keys.join("+")].some((text) => text.toLowerCase().includes(needle));
};
