/**
 * Keyboard shortcuts utilities for handling cross-platform shortcuts
 */

export type ModifierKey = "Ctrl" | "Cmd" | "Alt" | "Shift" | "ctrl" | "cmd" | "alt" | "shift" | "meta";
export type SpecialKey =
    | "Space"
    | "ArrowUp"
    | "ArrowDown"
    | "ArrowLeft"
    | "ArrowRight"
    | "Escape"
    | "Enter"
    | "Tab"
    | "Backspace"
    | "Delete"
    | "Home"
    | "End"
    | "PageUp"
    | "PageDown"
    | "Insert"
    | "F1"
    | "F2"
    | "F3"
    | "F4"
    | "F5"
    | "F6"
    | "F7"
    | "F8"
    | "F9"
    | "F10"
    | "F11"
    | "F12";

export interface KeyCombination {
    key: string | SpecialKey;
    modifiers: ModifierKey[];
}

/**
 * Detect the current platform to determine which modifier key to use for events
 * Always returns "ctrl" for storage, but "cmd" for event matching on Mac.
 */
export const getPlatformModifierForEvents = (): "ctrl" | "cmd" => {
    if (typeof navigator === "undefined") {
        return "ctrl";
    }

    const platform = navigator.platform.toLowerCase();
    const userAgent = navigator.userAgent.toLowerCase();

    // macOS detection
    if (platform.includes("mac") || userAgent.includes("mac")) {
        return "cmd";
    }

    return "ctrl";
};

/**
 * Always returns "ctrl" for storage - we standardize on "ctrl" in the database.
 */
export const getPlatformModifier = (): "ctrl" => "ctrl";

/**
 * Get the display text for the platform modifier key
 * Since we store as "ctrl" but display platform-appropriately.
 */
export const getPlatformModifierDisplay = (): string => {
    const modifier = getPlatformModifierForEvents();

    return modifier === "cmd" ? "⌘" : "Ctrl";
};

/**
 * Parse a shortcut string into a KeyCombination
 * Examples: "Ctrl+B", "Cmd+Shift+K", "Alt+F4".
 */
export const parseShortcut = (shortcut: string): KeyCombination | null => {
    if (!shortcut || typeof shortcut !== "string") {
        return null;
    }

    const parts = shortcut.split("+").map((part) => part.trim());

    if (parts.length === 0) {
        return null;
    }

    const modifiers: ModifierKey[] = [];
    let key: string | SpecialKey = "";

    for (const part of parts) {
        switch (part.toLowerCase()) {
            case "alt":
            case "option": {
                modifiers.push("Alt");
                break;
            }
            case "cmd":
            case "command":
            case "meta": {
                modifiers.push("Cmd");
                break;
            }
            case "control":
            case "ctrl": {
                modifiers.push("Ctrl");
                break;
            }
            case "shift": {
                modifiers.push("Shift");
                break;
            }
            default: {
                key = part as SpecialKey;
                break;
            }
        }
    }

    if (!key) {
        return null;
    }

    return { key, modifiers };
};

/**
 * Check if a keyboard event matches a shortcut string
 * Handles platform-specific modifier matching (ctrl/cmd).
 */
export const matchesShortcut = (event: KeyboardEvent, shortcut: string): boolean => {
    const combination = parseShortcut(shortcut);

    if (!combination) {
        return false;
    }

    const { key, modifiers } = combination;

    // Check if all required modifiers are pressed
    const ctrlPressed = event.ctrlKey || event.metaKey;
    const altPressed = event.altKey;
    const shiftPressed = event.shiftKey;

    for (const modifier of modifiers) {
        switch (modifier) {
            case "Alt":
            case "alt": {
                if (!altPressed) {
                    return false;
                }

                break;
            }
            case "Cmd":
            case "cmd":
            case "Ctrl":
            case "ctrl":
            case "meta": {
                if (!ctrlPressed) {
                    return false;
                }

                break;
            }
            case "Shift":
            case "shift": {
                if (!shiftPressed) {
                    return false;
                }

                break;
            }
            default: {
                // Unrecognised modifier name — nothing to require.
                break;
            }
        }
    }

    // Check if no extra modifiers are pressed (except allowed ones)
    const allowedExtraModifiers = modifiers.length > 0 ? [] : ["Shift", "shift"]; // Allow shift for single letter keys
    const hasExtraModifiers =
        (ctrlPressed && modifiers.every((m) => !["Cmd", "cmd", "Ctrl", "ctrl", "meta"].includes(m))) ||
        (altPressed && modifiers.every((m) => !["Alt", "alt"].includes(m))) ||
        (shiftPressed && modifiers.every((m) => !["Shift", "shift"].includes(m)) && allowedExtraModifiers.every((m) => !["Shift", "shift"].includes(m)));

    if (hasExtraModifiers) {
        return false;
    }

    // Check the main key
    const eventKey = normalizeKey(event.key);
    const shortcutKey = normalizeKey(key);

    return eventKey === shortcutKey;
};

/**
 * Normalize key names for consistent comparison.
 */
const normalizeKey = (key: string): string => {
    switch (key) {
        case " ": {
            return "Space";
        }
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "Backspace":
        case "Delete":
        case "End":
        case "Enter":
        case "Escape":
        case "Home":
        case "Insert":
        case "PageDown":
        case "PageUp":
        case "Tab": {
            return key;
        }
        default: {
            // For regular keys, compare case-insensitively
            return key.toLowerCase();
        }
    }
};

/**
 * Format a key combination as a display string.
 */
export const formatShortcut = (combination: KeyCombination): string => {
    const { key, modifiers } = combination;
    const parts = [...modifiers, key];

    return parts.join("+");
};

/**
 * Format a shortcut string for display (user-friendly).
 */
export const formatShortcutForDisplay = (shortcut: string): string => {
    if (!shortcut) {
        return "";
    }

    // Split by + and format each part
    const parts = shortcut.split("+").map((part) => part.trim());

    return parts
        .map((part) => {
            switch (part.toLowerCase()) {
                case "alt": {
                    return "Alt";
                }
                case "arrowdown": {
                    return "↓";
                }
                case "arrowleft": {
                    return "←";
                }
                case "arrowright": {
                    return "→";
                }
                case "arrowup": {
                    return "↑";
                }
                case "backspace": {
                    return "⌫";
                }
                case "cmd":
                case "meta": {
                    return "⌘";
                }
                case "ctrl": {
                    // Show platform-appropriate display for ctrl modifier
                    return getPlatformModifierForEvents() === "cmd" ? "⌘" : "Ctrl";
                }
                case "delete": {
                    return "Del";
                }
                case "end": {
                    return "End";
                }
                case "enter": {
                    return "Enter";
                }
                case "escape": {
                    return "Esc";
                }
                case "home": {
                    return "Home";
                }
                case "pagedown": {
                    return "PgDn";
                }
                case "pageup": {
                    return "PgUp";
                }
                case "shift": {
                    return "Shift";
                }
                case "space": {
                    return "Space";
                }
                case "tab": {
                    return "Tab";
                }
                default: {
                    // For single characters, capitalize them
                    return part.length === 1 ? part.toUpperCase() : part;
                }
            }
        })
        .join(" + ");
};

/**
 * Convert a keyboard event to a shortcut string
 * Always stores as "ctrl" format for database consistency.
 */
export const eventToShortcut = (event: KeyboardEvent): string => {
    const modifiers: string[] = [];

    if (event.ctrlKey || event.metaKey) {
        // Always store as "ctrl" in database, regardless of platform
        modifiers.push("ctrl");
    }

    if (event.altKey) {
        modifiers.push("alt");
    }

    if (event.shiftKey) {
        modifiers.push("shift");
    }

    const key = normalizeKey(event.key);

    if (modifiers.length === 0 && key.length === 1) {
        // Single letter without modifiers - use as-is for backend validation
        return key.toLowerCase();
    }

    // Join with + and use lowercase for backend validation
    return [...modifiers, key.toLowerCase()].join("+");
};

/**
 * Check if a shortcut is valid.
 */
export const isValidShortcut = (shortcut: string): boolean => parseShortcut(shortcut) !== null;

/**
 * Get all possible modifier combinations for a key.
 */
export const getModifierCombinations = (key: string): string[] => {
    const combinations: string[] = [];
    const modifiers: ModifierKey[] = ["ctrl", "alt", "shift"];

    // Generate all combinations
    for (let i = 0; i < 1 << modifiers.length; i++) {
        const combo: ModifierKey[] = [];

        for (const [j, modifier] of modifiers.entries()) {
            if (i & (1 << j)) {
                combo.push(modifier!); // We know j is within bounds
            }
        }

        if (combo.length > 0) {
            combinations.push(formatShortcut({ key: key as SpecialKey, modifiers: combo }));
        }
    }

    return combinations;
};
