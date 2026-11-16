/**
 * The OS accent colour from the desktop shell (`system-accent` capability). Apart from `bridge.ts` so the web build's
 * first load never carries it: only lazily loaded code imports this module.
 */
import type { UnlistenFunction } from "./bridge";
import { getNative, hasNativeCapability } from "./bridge";

const HEX_COLOR = /^#[\da-f]{6}$/i;

/** Anything but `#rrggbb` from the shell is treated as "no accent colour". */
const toAccentHex = (value: unknown): string | null => (typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : null);

/**
 * The OS accent colour as lower-case `#rrggbb`; `null` without `system-accent` or when the OS has none, and
 * `undefined` when the shell could not answer (keep whatever is painted).
 */
export const getNativeSystemAccentColor = async (): Promise<string | null | undefined> => {
    if (!hasNativeCapability("system-accent")) {
        return null;
    }

    const read = getNative()?.getSystemAccentColor;

    if (!read) {
        return undefined;
    }

    try {
        return toAccentHex(await read());
    } catch {
        return undefined;
    }
};

/** Calls `handler` with each change of the OS accent colour (`null`: none). A no-op without `system-accent`. */
export const onNativeSystemAccentColor = (handler: (hex: string | null) => void): UnlistenFunction => {
    if (!hasNativeCapability("system-accent")) {
        return () => {};
    }

    return getNative()?.onSystemAccentColor?.((value: string | null) => handler(toAccentHex(value))) ?? (() => {});
};

/**
 * The current OS accent colour, then each change. The initial read is dropped when a change arrived first (it may
 * predate it) or after the returned function ran, and is skipped when the shell could not answer.
 */
export const watchNativeSystemAccentColor = (handler: (hex: string | null) => void): UnlistenFunction => {
    let settled = false;
    const stop = onNativeSystemAccentColor((hex: string | null) => {
        settled = true;
        handler(hex);
    });

    void (async () => {
        const hex = await getNativeSystemAccentColor();

        if (settled || hex === undefined) {
            return;
        }

        settled = true;
        handler(hex);
    })();

    return () => {
        settled = true;
        stop();
    };
};
