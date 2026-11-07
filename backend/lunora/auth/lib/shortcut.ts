/**
 * A stored keyboard shortcut: optional `ctrl`/`cmd`/`meta`/`alt`/`shift` modifiers, then one key.
 * Kept in step with what `eventToShortcut` (`@neore/ui/utils/keyboard-shortcuts`) records, which
 * includes the `/` of the Help default and the Home and End of list navigation.
 */
const MODIFIERS = new Set(["alt", "cmd", "ctrl", "meta", "shift"]);

const NAMED_KEYS = new Set([
    "arrowdown",
    "arrowleft",
    "arrowright",
    "arrowup",
    "backspace",
    "delete",
    "end",
    "enter",
    "escape",
    "home",
    "insert",
    "pagedown",
    "pageup",
    "space",
    "tab",
]);

const FUNCTION_KEY_RE = /^f\d{1,2}$/;
const SINGLE_KEY_RE = /^[a-z0-9?/]$/;

const isKey = (key: string): boolean => NAMED_KEYS.has(key) || FUNCTION_KEY_RE.test(key) || SINGLE_KEY_RE.test(key);

/**
 * F6 and Shift+F6 move focus between the screen's areas (`apps/web/src/features/keyboard/hooks/use-focus-area-hotkeys.ts`).
 * They are fixed, so no saved binding may take them: a binding there would run beside the focus move.
 */
export const isFocusAreaShortcut = (value: string): boolean => {
    const parts = value.toLowerCase().split("+");
    const key = parts.pop() ?? "";

    return key === "f6" && parts.every((modifier) => modifier === "shift");
};

/** The empty string is a binding the user cleared: it is stored and means "unbound". */
export const isValidShortcut = (value: unknown): boolean => {
    if (value === "") {
        return true;
    }

    if (typeof value !== "string" || isFocusAreaShortcut(value)) {
        return false;
    }

    const parts = value.toLowerCase().split("+");
    const key = parts.pop() ?? "";

    return isKey(key) && parts.every((modifier) => MODIFIERS.has(modifier));
};

/**
 * The bindings with a focus-area key cleared. A binding on F6 or Shift+F6 that was saved before the key was reserved
 * reads as unbound, so it cannot run next to focus navigation.
 */
export const withoutFocusAreaKeys = <T extends { readonly [command: string]: unknown }>(shortcuts: T): T =>
    Object.fromEntries(
        Object.entries(shortcuts).map(([command, value]) => [command, typeof value === "string" && isFocusAreaShortcut(value) ? "" : value]),
    ) as T;
