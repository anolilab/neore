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

export type EffortCommand = "decreaseEffort" | "increaseEffort";

const EFFORT_COMMANDS: ReadonlySet<string> = new Set(["decreaseEffort", "increaseEffort"]);

/** A registered chord with its modifiers in one order, so `shift+ctrl+n` and `ctrl+shift+n` compare equal. */
const normalizeChord = (chord: string): string => {
    const parts = chord.split("+");
    const key = parts.pop() ?? "";

    return [...parts.toSorted((first, second) => first.localeCompare(second)), key].join("+");
};

const chordsOf = (shortcut: string | undefined, registered: string): ReadonlyArray<string> =>
    shortcut?.trim() ? registered.split(",").map((chord) => normalizeChord(chord)) : [];

const overlaps = (first: ReadonlyArray<string>, second: ReadonlyArray<string>): boolean => first.some((chord) => second.includes(chord));

/**
 * Which effort commands share a chord with something else, judged by the chords each binding
 * actually registers (a recorded Control chord also answers to Command on a Mac):
 * - `command`: the chord is also another command's binding, so one press would run both.
 * - `effort`: the two effort commands overlap each other.
 *
 * A command that is not bound, or whose chords are free, is absent from the result.
 */
export const findEffortConflicts = (
    shortcuts: Readonly<Record<string, string | undefined>>,
    platformModifier: "cmd" | "ctrl" = getPlatformModifierForEvents(),
): Partial<Record<EffortCommand, "command" | "effort">> => {
    const decrease = chordsOf(shortcuts.decreaseEffort, convertRecordedShortcutToHotkeysHook(shortcuts.decreaseEffort, platformModifier));
    const increase = chordsOf(shortcuts.increaseEffort, convertRecordedShortcutToHotkeysHook(shortcuts.increaseEffort, platformModifier));
    const others = Object.entries(shortcuts)
        .filter(([command]) => !EFFORT_COMMANDS.has(command))
        .flatMap(([, shortcut]) => chordsOf(shortcut, convertShortcutToHotkeysHook(shortcut)));
    const conflicts: Partial<Record<EffortCommand, "command" | "effort">> = {};

    for (const [command, chords] of [
        ["decreaseEffort", decrease],
        ["increaseEffort", increase],
    ] as const) {
        if (overlaps(chords, others)) {
            conflicts[command] = "command";
        } else if (overlaps(decrease, increase)) {
            conflicts[command] = "effort";
        }
    }

    return conflicts;
};
