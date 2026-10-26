import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WindowState } from "./window-state.js";
import { createDebouncer, intersectsAnyDisplay, parseWindowState, readWindowState, restorableState, writeWindowState } from "./window-state.js";

const state: WindowState = { bounds: { height: 800, width: 1100, x: 100, y: 50 }, maximized: false };
const display = { height: 1080, width: 1920, x: 0, y: 0 };

describe("parseWindowState", () => {
    it("reads a complete record", () => {
        expect(parseWindowState(JSON.stringify(state))).toStrictEqual(state);
    });

    it.each([
        ["no file", undefined],
        ["invalid JSON", "{not json"],
        ["a non-object", "42"],
        ["a missing maximized flag", JSON.stringify({ bounds: state.bounds })],
        ["a non-finite coordinate", JSON.stringify({ bounds: { ...state.bounds, x: "left" }, maximized: false })],
        ["a zero width", JSON.stringify({ bounds: { ...state.bounds, width: 0 }, maximized: false })],
    ])("falls back to the defaults (undefined) for %s", (_label, raw) => {
        expect(parseWindowState(raw)).toBeUndefined();
    });
});

describe("intersectsAnyDisplay and restorableState", () => {
    it("accepts a rectangle that lies on a connected display", () => {
        expect(restorableState(state, [display])).toStrictEqual(state);
    });

    it("rejects a rectangle that is off every display (a disconnected monitor)", () => {
        const offScreen: WindowState = { ...state, bounds: { ...state.bounds, x: 3000 } };

        expect(restorableState(offScreen, [display])).toBeUndefined();
    });

    it("rejects a rectangle that only touches a display edge", () => {
        expect(intersectsAnyDisplay({ height: 100, width: 100, x: -100, y: 0 }, [display])).toBe(false);
    });

    it("accepts a rectangle on any one of several displays", () => {
        const second = { height: 1080, width: 1920, x: 1920, y: 0 };
        const onSecond: WindowState = { ...state, bounds: { ...state.bounds, x: 2000 } };

        expect(restorableState(onSecond, [display, second])).toStrictEqual(onSecond);
    });

    it("uses the defaults when there is no saved state", () => {
        expect(restorableState(undefined, [display])).toBeUndefined();
    });
});

describe("atomic write", () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(path.join(os.tmpdir(), "neore-window-state-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("round-trips through the file and leaves no temp file behind", () => {
        const file = path.join(directory, "window-state.json");

        writeWindowState(file, { ...state, maximized: true });

        expect(readWindowState(file)).toStrictEqual({ ...state, maximized: true });
        expect(readdirSync(directory)).toStrictEqual(["window-state.json"]);
    });

    it("reads a corrupt file as the defaults", () => {
        const file = path.join(directory, "window-state.json");

        writeFileSync(file, "{");

        expect(readWindowState(file)).toBeUndefined();
        expect(readFileSync(file, "utf8")).toBe("{");
    });

    it("reads a missing file as the defaults", () => {
        expect(readWindowState(path.join(directory, "absent.json"))).toBeUndefined();
    });
});

describe("createDebouncer", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("runs once, after the last call, and flush runs a pending call now", () => {
        const action = vi.fn();
        const debounced = createDebouncer(action, 500);

        debounced.call();
        vi.advanceTimersByTime(300);
        debounced.call();
        vi.advanceTimersByTime(499);
        expect(action).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(action).toHaveBeenCalledTimes(1);

        debounced.call();
        debounced.flush();
        expect(action).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(1000);
        expect(action).toHaveBeenCalledTimes(2);
    });

    it("cancel drops a pending call", () => {
        const action = vi.fn();
        const debounced = createDebouncer(action, 500);

        debounced.call();
        debounced.cancel();
        vi.advanceTimersByTime(1000);
        debounced.flush();
        expect(action).not.toHaveBeenCalled();
    });
});
