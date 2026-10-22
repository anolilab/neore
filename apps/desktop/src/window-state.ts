/**
 * Main window bounds and maximized flag, kept across launches. The parsing,
 * the on-screen check and the debouncer are pure; the file I/O is plain `fs`
 * and needs no Electron, so tests run against a real temp directory.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export interface Bounds {
    height: number;
    width: number;
    x: number;
    y: number;
}

export interface WindowState {
    bounds: Bounds;
    maximized: boolean;
}

export const WINDOW_STATE_FILE = "window-state.json";

export const DEFAULT_SIZE = { height: 820, width: 1200 };

export const SAVE_DEBOUNCE_MS = 500;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Anything but a complete, sane record yields `undefined`, which means "use the defaults". */
export const parseWindowState = (raw: string | undefined): WindowState | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    let data: unknown;

    try {
        data = JSON.parse(raw);
    } catch {
        return undefined;
    }

    if (typeof data !== "object" || data === null) {
        return undefined;
    }

    const { bounds, maximized } = data as { bounds?: unknown; maximized?: unknown };

    if (typeof bounds !== "object" || bounds === null || typeof maximized !== "boolean") {
        return undefined;
    }

    const { height, width, x, y } = bounds as Record<string, unknown>;

    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height) || width < 1 || height < 1) {
        return undefined;
    }

    return { bounds: { height, width, x, y }, maximized };
};

/** Whether the rectangle overlaps any display's work area by a non-empty area. */
export const intersectsAnyDisplay = (bounds: Bounds, workAreas: Bounds[]): boolean =>
    workAreas.some((area) => {
        const overlapWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
        const overlapHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);

        return overlapWidth > 0 && overlapHeight > 0;
    });

/** The saved state when its rectangle still lies on a connected display, otherwise `undefined` (use the defaults). */
export const restorableState = (saved: WindowState | undefined, workAreas: Bounds[]): WindowState | undefined =>
    saved !== undefined && intersectsAnyDisplay(saved.bounds, workAreas) ? saved : undefined;

const serializeWindowState = (state: WindowState): string => `${JSON.stringify(state, null, 2)}\n`;

export const readWindowState = (file: string): WindowState | undefined => {
    try {
        return parseWindowState(readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
};

/** Temp file in the same directory, then rename: a crash mid-write leaves the old file, never a torn one. */
export const writeWindowState = (file: string, state: WindowState): void => {
    const temporary = `${file}.${process.pid}.tmp`;

    writeFileSync(temporary, serializeWindowState(state));
    renameSync(temporary, file);
};

/** Runs `action` once, `delay` ms after the last `call`. `flush` runs a pending call now; `cancel` drops it. */
export const createDebouncer = (action: () => void, delay: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cancel = (): void => {
        if (timer === undefined) {
            return;
        }

        clearTimeout(timer);
        timer = undefined;
    };

    return {
        call: (): void => {
            cancel();
            timer = setTimeout(() => {
                timer = undefined;
                action();
            }, delay);
        },
        cancel,
        flush: (): void => {
            if (timer === undefined) {
                return;
            }

            cancel();
            action();
        },
    };
};
