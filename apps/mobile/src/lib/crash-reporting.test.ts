import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreferenceStore } from "./crash-report-preference";

/** A preference store that records each save in the shared event order. */
const memoryStore = (events: string[], initial: string | null = null, isSaveFailing = false): PreferenceStore & { value: string | null } => {
    const store = {
        get: async (): Promise<string | null> => store.value,
        set: async (value: string): Promise<void> => {
            events.push(`save:${value}`);

            if (isSaveFailing) {
                throw new Error("keychain is unavailable");
            }

            store.value = value;
        },
        value: initial,
    };

    return store;
};

/** A stand-in for the PostHog client that records the opt-in and opt-out calls in the shared event order. */
const fakeClient = (events: string[]) => {
    return {
        captureException: vi.fn(),
        optIn: vi.fn(async (): Promise<void> => {
            events.push("optIn");
        }),
        optOut: vi.fn(async (): Promise<void> => {
            events.push("optOut");
        }),
    };
};

/** The global handler as the app sees it: the one installed, and the one that was there before. */
const handlers: { installed?: (error: unknown, isFatal?: boolean) => void; previous: ReturnType<typeof vi.fn> } = { previous: vi.fn() };

beforeEach(() => {
    handlers.previous = vi.fn();
    handlers.installed = undefined;
    vi.stubGlobal("ErrorUtils", {
        getGlobalHandler: () => handlers.previous,
        setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => {
            handlers.installed = handler;
        },
    });

    // The module keeps its state between calls, so each test loads a fresh copy.
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const load = () => import("./crash-reporting");

describe("changing the choice", () => {
    it("opts the client in and saves the choice", async () => {
        const events: string[] = [];
        const crash = await load();

        crash.startCrashReporting(() => fakeClient(events));

        await crash.changeCrashReports(memoryStore(events, null), true);

        expect(events).toEqual(["optIn", "save:on"]);
        expect(await crash.crashReportsOn()).toBe(true);
    });

    it("opts the client out before saving the choice, so a save that fails still leaves reporting off", async () => {
        const events: string[] = [];
        const crash = await load();

        crash.startCrashReporting(() => fakeClient(events));

        await expect(crash.changeCrashReports(memoryStore(events, "on", true), false)).rejects.toThrow("keychain is unavailable");

        expect(events).toEqual(["optOut", "save:off"]);
        expect(await crash.crashReportsOn()).toBe(false);
    });

    it("keeps the state as it was when the client refuses the change", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        client.optIn.mockImplementation(async () => {
            throw new Error("sdk refused");
        });
        crash.startCrashReporting(() => client);
        const store = memoryStore(events, null);

        await expect(crash.changeCrashReports(store, true)).rejects.toThrow("sdk refused");

        expect(store.value).toBeNull();
        expect(await crash.crashReportsOn()).toBe(false);
    });
});

describe("applying the saved choice at startup", () => {
    it("opts the client in when the saved choice is on", async () => {
        const events: string[] = [];
        const crash = await load();

        crash.startCrashReporting(() => fakeClient(events));

        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"));

        expect(events).toEqual(["optIn"]);
        expect(await crash.crashReportsOn()).toBe(true);
    });

    it("leaves reporting off when nothing has been saved", async () => {
        const events: string[] = [];
        const crash = await load();

        crash.startCrashReporting(() => fakeClient(events));

        await crash.applyStoredCrashReportChoice(memoryStore(events, null));

        expect(events).not.toContain("optIn");
        expect(await crash.crashReportsOn()).toBe(false);
    });

    it("logs a refused opt-in and leaves reporting off, without failing startup", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        client.optIn.mockImplementation(async () => {
            throw new Error("sdk refused");
        });
        crash.startCrashReporting(() => client);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(crash.applyStoredCrashReportChoice(memoryStore(events, "on"))).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith("Could not apply the crash-report setting.", expect.any(Error));
        expect(await crash.crashReportsOn()).toBe(false);
    });
});

describe("the global error handler", () => {
    it("hands no error to the SDK while reporting is off, and still runs the previous handler", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        crash.startCrashReporting(() => client);
        crash.installGlobalErrorReporting();
        const error = new TypeError("the reply said: buy milk");

        handlers.installed?.(error, true);

        expect(client.captureException).not.toHaveBeenCalled();
        expect(handlers.previous).toHaveBeenCalledWith(error, true);
    });

    it("sends a scrubbed report once reporting is on, without the error message", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        crash.startCrashReporting(() => client);
        crash.installGlobalErrorReporting();
        await crash.changeCrashReports(memoryStore(events, null), true);
        const error = new TypeError("the reply said: buy milk");

        // eslint-disable-next-line unicorn/no-error-property-assignment -- stands in for the stack the engine records when the error is thrown
        Object.assign(error, { stack: "TypeError: the reply said: buy milk\n    at renderRow (app/chat.tsx:10:4)" });

        handlers.installed?.(error, false);

        const [sent, options] = client.captureException.mock.calls[0] as [Error, { fatal: boolean }];

        expect(sent.name).toBe("TypeError");
        expect(sent.message).toBe("");
        expect(sent.stack).toBe("    at renderRow (app/chat.tsx:10:4)");
        expect(options).toEqual({ fatal: false });
        expect(handlers.previous).toHaveBeenCalledWith(error, false);
    });

    it("still runs the previous handler when the SDK throws", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        client.captureException.mockImplementation(() => {
            throw new Error("sdk failed");
        });
        crash.startCrashReporting(() => client);
        crash.installGlobalErrorReporting();
        await crash.changeCrashReports(memoryStore(events, null), true);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const error = new Error("boom");

        expect(() => {
            handlers.installed?.(error, true);
        }).not.toThrow();

        expect(handlers.previous).toHaveBeenCalledWith(error, true);
        expect(warn).toHaveBeenCalledWith("A crash report could not be sent.");
    });

    it("installs one handler however many times it is asked", async () => {
        const crash = await load();
        const setGlobalHandler = vi.fn();

        vi.stubGlobal("ErrorUtils", { getGlobalHandler: () => handlers.previous, setGlobalHandler });

        crash.installGlobalErrorReporting();
        crash.installGlobalErrorReporting();

        expect(setGlobalHandler).toHaveBeenCalledOnce();
    });
});
