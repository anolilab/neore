/**
 * Converts our shortcut format to react-hotkeys-hook format
 *
 * Our format: "ctrl+k", "cmd+shift+r", "escape", "arrowdown"
 * react-hotkeys-hook format: "ctrl+k", "meta+shift+r", "esc", "arrowdown"
 *
 * Main differences:
 * - "cmd" needs to be converted to "meta" for cross-platform compatibility
 * - "escape" needs to be converted to "esc"
 * - Arrow keys are already in correct format.
 */
const convertShortcutToHotkeysHook = (shortcut: string | undefined): string => {
    if (!shortcut || typeof shortcut !== "string" || shortcut.trim() === "") {
        // Return a safe default that won't conflict with any real shortcuts
        // Using a combination that's extremely unlikely to be used
        return "f24+shift+alt+ctrl"; // F24 with all modifiers - very unlikely to conflict
    }

    // Split the shortcut to handle modifiers and keys separately
    const parts = shortcut.toLowerCase().split("+");
    const modifiers = parts.slice(0, -1);
    const key = parts.at(-1) || "";

    // Convert modifiers: cmd -> meta
    const convertedModifiers = modifiers.map((module_) => {
        if (module_ === "cmd" || module_ === "command") {
            return "meta";
        }

        return module_;
    });

    // Convert special keys
    const keyMap: Record<string, string> = {
        // Arrow keys are already correct
        arrowdown: "arrowdown",
        arrowleft: "arrowleft",
        arrowright: "arrowright",
        arrowup: "arrowup",
        escape: "esc",
    };

    const convertedKey = keyMap[key] || key;

    // Reassemble the shortcut
    if (convertedModifiers.length > 0) {
        return `${convertedModifiers.join("+")}+${convertedKey}`;
    }

    return convertedKey;
};

export default convertShortcutToHotkeysHook;
