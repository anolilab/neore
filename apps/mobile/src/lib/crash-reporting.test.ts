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
/** An install that has started before: its saved choice is trusted. */
const returningInstall = { create: (): void => undefined, exists: (): boolean => true };

/** A new install, which resets any saved choice before reading it. */
const newInstall = () => {
    const marker = {
        create: (): void => {
            marker.created = true;
        },
        created: false,
        exists: (): boolean => false,
    };

    return marker;
};

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

        await crash.changeCrashReports(memoryStore(events, null), true, returningInstall);

        expect(events).toEqual(["optIn", "save:on"]);
        expect(await crash.crashReportsOn()).toBe(true);
    });

    it("opts the client out before saving the choice, so a save that fails still leaves reporting off", async () => {
        const events: string[] = [];
        const crash = await load();

        crash.startCrashReporting(() => fakeClient(events));
        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);
        events.length = 0;

        await expect(crash.changeCrashReports(memoryStore(events, "on", true), false, returningInstall)).rejects.toThrow("keychain is unavailable");

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

        await expect(crash.changeCrashReports(store, true, returningInstall)).rejects.toThrow("sdk refused");

        expect(store.value).toBeNull();
        expect(await crash.crashReportsOn()).toBe(false);
    });
});

describe("applying the saved choice at startup", () => {
    it("opts the client in when the saved choice is on", async () => {
        const events: string[] = [];
        const crash = await load();

        crash.startCrashReporting(() => fakeClient(events));

        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);

        expect(events).toEqual(["optIn"]);
        expect(await crash.crashReportsOn()).toBe(true);
    });

    it("leaves reporting off when nothing has been saved", async () => {
        const events: string[] = [];
        const crash = await load();

        crash.startCrashReporting(() => fakeClient(events));

        await crash.applyStoredCrashReportChoice(memoryStore(events, null), returningInstall);

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

        await expect(crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall)).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith("Could not apply the crash-report setting.", expect.any(Error));
        expect(await crash.crashReportsOn()).toBe(false);
    });
});

describe("a new install", () => {
    it("starts off when the install marker cannot be read", async () => {
        const events: string[] = [];
        const crash = await load();
        const create = vi.fn(() => fakeClient(events));

        crash.startCrashReporting(create);
        const unreadable = {
            create: (): void => undefined,
            exists: (): boolean => {
                throw new Error("document folder unavailable");
            },
        };

        await expect(crash.applyStoredCrashReportChoice(memoryStore(events, "on"), unreadable)).resolves.toBeUndefined();

        expect(create).not.toHaveBeenCalled();
        expect(await crash.crashReportsOn()).toBe(false);
    });

    it("counts as started once an explicit choice is saved, even if the reset never was", async () => {
        const events: string[] = [];
        const crash = await load();

        crash.startCrashReporting(() => fakeClient(events));
        const marker = newInstall();

        await crash.changeCrashReports(memoryStore(events, null), true, marker);

        expect(marker.created).toBe(true);
    });

    it("resets a choice saved by an earlier install, and does not start the client for it", async () => {
        const events: string[] = [];
        const crash = await load();
        const create = vi.fn(() => fakeClient(events));

        crash.startCrashReporting(create);
        const store = memoryStore(events, "on");
        const marker = newInstall();

        await crash.applyStoredCrashReportChoice(store, marker);

        expect(store.value).toBe("off");
        expect(create).not.toHaveBeenCalled();
        expect(marker.created).toBe(true);
        expect(await crash.crashReportsOn()).toBe(false);
    });

    it("does not start the client when the reset cannot be saved, and tries again next launch", async () => {
        const events: string[] = [];
        const crash = await load();
        const create = vi.fn(() => fakeClient(events));

        crash.startCrashReporting(create);
        const marker = newInstall();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await crash.applyStoredCrashReportChoice(memoryStore(events, "on", true), marker);

        expect(create).not.toHaveBeenCalled();
        expect(marker.created).toBe(false);
        expect(warn).toHaveBeenCalledWith("Could not reset the saved crash-report choice.");
    });
});

describe("making the client", () => {
    it("is not made while reporting has never been turned on", async () => {
        const events: string[] = [];
        const crash = await load();
        const create = vi.fn(() => fakeClient(events));

        crash.startCrashReporting(create);

        await crash.applyStoredCrashReportChoice(memoryStore(events, null), returningInstall);

        expect(create).not.toHaveBeenCalled();
    });

    it("is made when a saved opt-in is applied at startup", async () => {
        const events: string[] = [];
        const crash = await load();
        const create = vi.fn(() => fakeClient(events));

        crash.startCrashReporting(create);

        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);

        expect(create).toHaveBeenCalledOnce();
    });
});

describe("the global error handler", () => {
    it("holds a crash until the saved choice is known, then sends it when the choice is on", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        crash.startCrashReporting(() => client);
        crash.installGlobalErrorReporting();

        handlers.installed?.(new Error("during startup"), true);

        expect(client.captureException).not.toHaveBeenCalled();

        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);

        expect(client.captureException).toHaveBeenCalledOnce();
        expect(client.captureException.mock.calls[0]?.[1]).toEqual({ fatal: true });
    });

    it("drops a crash held before the saved choice is known, when the choice is off", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        crash.startCrashReporting(() => client);
        crash.installGlobalErrorReporting();

        handlers.installed?.(new Error("during startup"), false);
        await crash.applyStoredCrashReportChoice(memoryStore(events, null), returningInstall);

        expect(client.captureException).not.toHaveBeenCalled();
    });

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
        await crash.changeCrashReports(memoryStore(events, null), true, returningInstall);
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

    it("hands no error to the SDK while an opt-out is still pending", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        crash.startCrashReporting(() => client);
        crash.installGlobalErrorReporting();
        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);
        const release: { finish?: () => void } = {};

        client.optOut.mockImplementation(async () => {
            await new Promise<void>((resolve) => {
                release.finish = resolve;
            });
        });

        const pending = crash.changeCrashReports(memoryStore(events, "on"), false, returningInstall);

        // Let the queued change start, so the opt-out is in progress when the error arrives.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        const error = new Error("during the opt-out");

        handlers.installed?.(error, false);
        release.finish?.();
        await pending;

        expect(client.captureException).not.toHaveBeenCalled();
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
        await crash.changeCrashReports(memoryStore(events, null), true, returningInstall);
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
