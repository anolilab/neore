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

/** The revocation record, kept in memory: it is there until removed. */
const memoryFlag = (isInitiallySet = false) => {
    let isSet = isInitiallySet;

    return {
        create: vi.fn((): void => {
            isSet = true;
        }),
        exists: (): boolean => isSet,
        remove: vi.fn((): void => {
            isSet = false;
        }),
    };
};

/** A stand-in for the PostHog client that records the opt-in and opt-out calls in the shared event order. */
const fakeClient = (events: string[]) => {
    return {
        captureException: vi.fn(),
        flush: vi.fn(async (): Promise<void> => undefined),
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

        crash.startCrashReporting(() => fakeClient(events), memoryFlag());

        await crash.changeCrashReports(memoryStore(events, null), true, returningInstall);

        expect(events).toEqual(["optIn", "save:on"]);
        expect(await crash.crashReportsOn()).toBe(true);
    });

    it("opts the client out before saving the choice, so a save that fails still leaves reporting off", async () => {
        const events: string[] = [];
        const crash = await load();

        crash.startCrashReporting(() => fakeClient(events), memoryFlag());
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
        crash.startCrashReporting(() => client, memoryFlag());
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

        crash.startCrashReporting(() => fakeClient(events), memoryFlag());

        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);

        expect(events).toEqual(["optIn"]);
        expect(await crash.crashReportsOn()).toBe(true);
    });

    it("leaves reporting off when nothing has been saved", async () => {
        const events: string[] = [];
        const crash = await load();

        crash.startCrashReporting(() => fakeClient(events), memoryFlag());

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
        crash.startCrashReporting(() => client, memoryFlag());
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall)).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith("Could not apply the crash-report setting.", expect.any(Error));
        expect(await crash.crashReportsOn()).toBe(false);
    });
});

describe("a saved opt-out that did not persist", () => {
    it("is recorded before the save, so a save that fails does not restore the older opt-in at the next launch", async () => {
        const events: string[] = [];
        const crash = await load();
        const flag = memoryFlag();

        crash.startCrashReporting(() => fakeClient(events), flag);
        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);
        await expect(crash.changeCrashReports(memoryStore(events, "on", true), false, returningInstall)).rejects.toThrow("keychain is unavailable");

        expect(flag.exists()).toBe(true);

        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);

        expect(await crash.crashReportsOn()).toBe(false);
    });

    it("is removed once the opt-out is saved", async () => {
        const events: string[] = [];
        const crash = await load();
        const flag = memoryFlag();

        crash.startCrashReporting(() => fakeClient(events), flag);
        await crash.changeCrashReports(memoryStore(events, "on"), false, returningInstall);

        expect(flag.exists()).toBe(false);
    });

    it("wins over a saved opt-in at startup, and the save is tried again", async () => {
        const events: string[] = [];
        const crash = await load();
        const store = memoryStore(events, "on");

        crash.startCrashReporting(() => fakeClient(events), memoryFlag(true));
        await crash.applyStoredCrashReportChoice(store, returningInstall);

        expect(await crash.crashReportsOn()).toBe(false);
        expect(store.value).toBe("off");
    });
});

describe("changing the choice when a step fails", () => {
    it("still saves the opt-out when the SDK refuses it, and raises the refusal afterwards", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);
        const store = memoryStore(events, "on");

        client.optOut.mockRejectedValue(new Error("sdk refused the opt-out"));
        crash.startCrashReporting(() => client, memoryFlag());
        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);

        await expect(crash.changeCrashReports(store, false, returningInstall)).rejects.toThrow("sdk refused the opt-out");

        expect(store.value).toBe("off");
        expect(await crash.crashReportsOn()).toBe(false);
    });

    it("refuses an opt-in, and leaves reporting off, when a stale opt-out record cannot be removed", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);
        const flag = {
            ...memoryFlag(true),
            remove: vi.fn(() => {
                throw new Error("file is locked");
            }),
        };

        crash.startCrashReporting(() => client, flag);

        await expect(crash.changeCrashReports(memoryStore(events, null), true, returningInstall)).rejects.toThrow("file is locked");

        expect(await crash.crashReportsOn()).toBe(false);
        expect(flag.exists()).toBe(true);
    });

    it("turns reporting back off when the opt-in cannot be saved, and releases nothing", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        crash.startCrashReporting(() => client, memoryFlag());
        await crash.applyStoredCrashReportChoice(memoryStore(events, "off"), returningInstall);

        await expect(crash.changeCrashReports(memoryStore(events, null, true), true, returningInstall)).rejects.toThrow("keychain is unavailable");

        expect(client.optOut).toHaveBeenCalled();
        expect(await crash.crashReportsOn()).toBe(false);
    });

    it("says the opt-out was not kept when neither the record nor the saved choice could be written", async () => {
        const events: string[] = [];
        const crash = await load();
        const flag = { ...memoryFlag(), create: vi.fn(() => {
            throw new Error("disk full");
        }) };

        crash.startCrashReporting(() => fakeClient(events), flag);
        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);

        await expect(crash.changeCrashReports(memoryStore(events, "on", true), false, returningInstall)).rejects.toBeInstanceOf(crash.UnsavedOptOutError);
    });
});

describe("a new install", () => {
    it("starts off when the install marker cannot be read", async () => {
        const events: string[] = [];
        const crash = await load();
        const create = vi.fn(() => fakeClient(events));

        crash.startCrashReporting(create, memoryFlag());
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

        crash.startCrashReporting(() => fakeClient(events), memoryFlag());
        const marker = newInstall();

        await crash.changeCrashReports(memoryStore(events, null), true, marker);

        expect(marker.created).toBe(true);
    });

    it("resets a choice saved by an earlier install, and does not start the client for it", async () => {
        const events: string[] = [];
        const crash = await load();
        const create = vi.fn(() => fakeClient(events));

        crash.startCrashReporting(create, memoryFlag());
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

        crash.startCrashReporting(create, memoryFlag());
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

        crash.startCrashReporting(create, memoryFlag());

        await crash.applyStoredCrashReportChoice(memoryStore(events, null), returningInstall);

        expect(create).not.toHaveBeenCalled();
    });

    it("is made when a saved opt-in is applied at startup", async () => {
        const events: string[] = [];
        const crash = await load();
        const create = vi.fn(() => fakeClient(events));

        crash.startCrashReporting(create, memoryFlag());

        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);

        expect(create).toHaveBeenCalledOnce();
    });
});

describe("the global error handler", () => {
    it("waits for the saved choice before a fatal error ends the app, and sends the report held before it when the choice is on", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        crash.startCrashReporting(() => client, memoryFlag());
        crash.installGlobalErrorReporting();
        // The saved choice is still being read when the error arrives.
        const startup = crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);
        const error = new Error("boom during first render");

        handlers.installed?.(error, true);

        expect(handlers.previous).not.toHaveBeenCalled();

        await startup;

        await vi.waitFor(() => {
            expect(handlers.previous).toHaveBeenCalledWith(error, true);
        });
        expect(client.captureException).toHaveBeenCalledWith(expect.anything(), { fatal: true });
    });

    it("gives a fatal report a bounded moment to leave before the previous handler ends the app", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        client.flush.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    setTimeout(resolve, 10);
                }),
        );
        crash.startCrashReporting(() => client, memoryFlag());
        crash.installGlobalErrorReporting();
        await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);
        const error = new Error("boom");

        handlers.installed?.(error, true);

        expect(handlers.previous).not.toHaveBeenCalled();

        await vi.waitFor(() => {
            expect(handlers.previous).toHaveBeenCalledWith(error, true);
        });
    });

    it("runs the previous handler when a fatal flush hangs, once the bound has passed", async () => {
        vi.useFakeTimers();

        try {
            const events: string[] = [];
            const crash = await load();
            const client = fakeClient(events);

            client.flush.mockImplementation(
                () =>
                    new Promise<void>(() => {
                        // A flush that never settles.
                    }),
            );
            crash.startCrashReporting(() => client, memoryFlag());
            crash.installGlobalErrorReporting();
            await crash.applyStoredCrashReportChoice(memoryStore(events, "on"), returningInstall);
            const error = new Error("boom");

            handlers.installed?.(error, true);
            await vi.advanceTimersByTimeAsync(crash.FATAL_FLUSH_MS);

            expect(handlers.previous).toHaveBeenCalledWith(error, true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("holds a crash until the saved choice is known, then sends it when the choice is on", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        crash.startCrashReporting(() => client, memoryFlag());
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

        crash.startCrashReporting(() => client, memoryFlag());
        crash.installGlobalErrorReporting();

        handlers.installed?.(new Error("during startup"), false);
        await crash.applyStoredCrashReportChoice(memoryStore(events, null), returningInstall);

        expect(client.captureException).not.toHaveBeenCalled();
    });

    it("hands no error to the SDK while reporting is off, and still runs the previous handler", async () => {
        const events: string[] = [];
        const crash = await load();
        const client = fakeClient(events);

        crash.startCrashReporting(() => client, memoryFlag());
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

        crash.startCrashReporting(() => client, memoryFlag());
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

        crash.startCrashReporting(() => client, memoryFlag());
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
        crash.startCrashReporting(() => client, memoryFlag());
        crash.installGlobalErrorReporting();
        await crash.changeCrashReports(memoryStore(events, null), true, returningInstall);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const error = new Error("boom");

        expect(() => {
            handlers.installed?.(error, true);
        }).not.toThrow();

        await vi.waitFor(() => {
            expect(handlers.previous).toHaveBeenCalledWith(error, true);
        });
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
