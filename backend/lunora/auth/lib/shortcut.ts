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

/** The empty string is a binding the user cleared: it is stored and means "unbound". */
export const isValidShortcut = (value: unknown): boolean => {
    if (value === "") {
        return true;
    }

    if (typeof value !== "string") {
        return false;
    }

    const parts = value.toLowerCase().split("+");
    const key = parts.pop() ?? "";

    return isKey(key) && parts.every((modifier) => MODIFIERS.has(modifier));
};
