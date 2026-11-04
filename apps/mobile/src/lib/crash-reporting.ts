import type { PostHog } from "posthog-react-native";

import type { PreferenceStore } from "./crash-report-preference";
import { readCrashReportsEnabled, writeCrashReportsEnabled } from "./crash-report-preference";
import { toCrashReport } from "./crash-report-scrub";
import { createSerialQueue } from "./serial-queue";

/** The part of the SDK this module uses. A test can supply its own. */
export type CrashReportClient = Pick<PostHog, "captureException" | "flush" | "optIn" | "optOut">;

/** The handler React Native calls for an error that reaches the global handler. */
type ErrorHandler = (error: unknown, isFatal?: boolean) => void;

/** How long a fatal report may take to leave before the previous handler ends the app. */
export const FATAL_FLUSH_MS = 2000;

/** A scrubbed report, and whether it was a fatal error. */
interface HeldReport {
    fatal: boolean;
    report: ReturnType<typeof toCrashReport>;
}

/** How many reports are kept while the saved choice is not yet known. The newest are kept. */
const MAX_HELD_REPORTS = 5;

/**
 * A record that an opt-out was made. It is written before the saved choice, which can fail, and removed once the saved
 * choice is off. A record that is still there at launch means the saved "on" is not trusted.
 */
export interface RevocationFlag {
    create: () => void;
    exists: () => boolean;
    remove: () => void;
}

const state: {
    /** Settles once the saved choice is applied at startup. */
    choiceSettled?: Promise<void>;
    client?: CrashReportClient;
    create?: () => CrashReportClient;
    held: HeldReport[];
    isChoiceKnown: boolean;
    isHandlerInstalled: boolean;
    isOn: boolean;
    revocation?: RevocationFlag;
} = {
    held: [],
    isChoiceKnown: false,
    isHandlerInstalled: false,
    isOn: false,
};

/**
 * Reads the saved choice and changes it. Both run one at a time, so a startup read
 * cannot apply an older choice after a newer one has been made.
 */
const runChoice = createSerialQueue();

/**
 * Records how to make the client, and where an opt-out is recorded. Nothing is made here: the client is made only when
 * reporting is first turned on, so a user who never opted in never loads the SDK.
 */
export const startCrashReporting = (create: () => CrashReportClient, revocation: RevocationFlag): void => {
    state.create = create;
    state.revocation = revocation;
};

/** The client, made the first time it is needed. `undefined` when reporting is not configured. */
const clientForOn = (): CrashReportClient | undefined => {
    state.client ??= state.create?.();

    return state.client;
};

/**
 * Turns the client on or off. An off change makes no client: one that was never made has nothing to opt out.
 * Turning off closes the capture gate first, so no error reaches the SDK while its opt-out is still pending.
 * Turning on records the state only once the client has accepted the change.
 */
const applyToClient = async (isOn: boolean): Promise<void> => {
    if (!isOn) {
        state.isOn = false;
        await state.client?.optOut();

        return;
    }

    const client = clientForOn();

    if (!client) {
        return;
    }

    await client.optIn();
    state.isOn = true;
};

/** Hands one scrubbed report to the SDK. Only reached once the applied choice is on. */
const sendReport = ({ fatal, report }: HeldReport): void => {
    try {
        // The SDK reads `name` and `stack` from the error. The message stays empty, so no user text is sent.
        // eslint-disable-next-line unicorn/no-error-property-assignment, unicorn/error-message -- the fields are the scrubbed report
        const sendable = Object.assign(new Error(""), { name: report.name, stack: report.stack });

        state.client?.captureException(sendable, { fatal });
    } catch {
        // A reporting failure must not hide the crash. The error itself is not logged: its message and stack can hold chat text.
        console.warn("A crash report could not be sent.");
    }
};

/**
 * Records that the saved choice is known. The reports held until now are sent if the applied choice is on, and
 * dropped if it is off.
 */
const settleChoice = (): void => {
    const { held } = state;

    state.isChoiceKnown = true;
    state.held = [];

    if (state.isOn) {
        for (const item of held) {
            sendReport(item);
        }
    }
};

/** Whether reports are being sent right now. Read through the queue, so it follows any change still in progress. */
export const crashReportsOn = (): Promise<boolean> => runChoice(async () => state.isOn);

/**
 * Records an opt-out before the saved choice is written. If that write fails, the record still tells the next launch
 * that the saved "on" is out of date. Returns whether the record was written.
 */
const isRevocationRecorded = (): boolean => {
    try {
        state.revocation?.create();

        return true;
    } catch {
        console.warn("Could not record the crash-report opt-out.");

        return false;
    }
};

/** An opt-out that neither the record nor the saved choice could keep. The next launch may turn reporting back on. */
export class UnsavedOptOutError extends Error {
    public constructor() {
        super("The opt-out could not be saved.");
        this.name = "UnsavedOptOutError";
    }
}

/**
 * An opt-out. The client is switched off first, and the record and the saved choice are written even if the client
 * refuses the change: the refusal is raised once they are done, so the saved choice is never left as "on" by it.
 */
const turnOff = async (store: PreferenceStore): Promise<void> => {
    let clientError: { error: unknown } | undefined;

    try {
        await applyToClient(false);
    } catch (error) {
        clientError = { error };
    }

    settleChoice();

    const isRecorded = isRevocationRecorded();

    try {
        await writeCrashReportsEnabled(store, false);
    } catch (saveError) {
        if (!isRecorded) {
            throw new UnsavedOptOutError();
        }

        throw saveError;
    }

    state.revocation?.remove();

    if (clientError) {
        throw clientError.error;
    }
};

/** Turns reporting back off after an opt-in could not be kept, so the session matches what the next launch will read. */
const rollBackOptIn = async (): Promise<void> => {
    try {
        await applyToClient(false);
    } catch {
        console.warn("Could not turn reporting back off.");
    }
};

/**
 * An opt-in. Reporting is enabled first, but nothing is released until the saved choice is written. The record of an
 * earlier opt-out is removed only after that write: until then it keeps the next launch off. If either step fails,
 * reporting is turned back off, so the session matches the next launch.
 */
const turnOn = async (store: PreferenceStore, marker: InstallMarker): Promise<void> => {
    await applyToClient(true);

    try {
        await writeCrashReportsEnabled(store, true);
        state.revocation?.remove();
    } catch (error) {
        await rollBackOptIn();
        throw error;
    }

    settleChoice();
    // A choice made on this install is trusted, so the install counts as started from here on.
    marker.create();
};

/** Changes the choice, one change at a time. */
export const changeCrashReports = (store: PreferenceStore, isOn: boolean, marker: InstallMarker): Promise<void> =>
    runChoice(async () => {
        if (isOn) {
            await turnOn(store, marker);

            return;
        }

        await turnOff(store);
    });

/** Whether this install has been started before, and a way to mark that it has. */
export interface InstallMarker {
    create: () => void;
    exists: () => boolean;
}

/**
 * The choice to start with. A new install starts off: the Keychain can still hold a choice from an app that was
 * deleted, and nobody has agreed to that choice on this install. If the reset cannot be saved, the next launch
 * tries again. A store that cannot be read is off.
 */
const startupChoice = async (store: PreferenceStore, marker: InstallMarker): Promise<boolean> => {
    let isReturning: boolean;

    try {
        isReturning = marker.exists();
    } catch {
        // Without the marker it cannot be told whether this is a new install, so the choice is not trusted this launch.
        return false;
    }

    if (!isReturning) {
        try {
            await writeCrashReportsEnabled(store, false);
            marker.create();
        } catch {
            console.warn("Could not reset the saved crash-report choice.");
        }

        return false;
    }

    let isRevoked: boolean;

    try {
        isRevoked = state.revocation?.exists() === true;
    } catch {
        // Without the record it cannot be told whether an opt-out was made, so the choice is not trusted this launch.
        return false;
    }

    if (isRevoked) {
        // An opt-out was made but its save did not persist: the choice is off, and the save is tried again.
        try {
            await writeCrashReportsEnabled(store, false);
            state.revocation?.remove();
        } catch {
            console.warn("Could not record the saved crash-report opt-out.");
        }

        return false;
    }

    try {
        return await readCrashReportsEnabled(store);
    } catch {
        // Nothing was sent: the client starts opted out.
        return false;
    }
};

/**
 * Applies the saved choice at startup, then sends or drops the crashes held until the choice was known. Errors
 * caught before this runs are held, not sent.
 */
export const applyStoredCrashReportChoice = (store: PreferenceStore, marker: InstallMarker): Promise<void> => {
    const settled = runChoice(async () => {
        const isOn = await startupChoice(store, marker);

        try {
            await applyToClient(isOn);
        } catch (applyError) {
            console.warn("Could not apply the crash-report setting.", applyError);
        }

        settleChoice();
    });

    state.choiceSettled = settled;

    return settled;
};

/**
 * Lets one step of a fatal error finish, for at most `FATAL_FLUSH_MS`. A step that fails or hangs is not waited for
 * any longer: the previous handler must still run.
 */
const boundedWait = async (work: () => Promise<unknown>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FATAL_FLUSH_MS);
    });

    try {
        await Promise.race([work(), timeout]);
    } catch {
        // A failed step is not a reason to hide the crash.
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Hands a fatal error to the previous handler once the report has had its bounded moment to leave. A report held
 * before the saved choice is known waits for that choice first, so it is sent when the choice is on.
 */
const endAfterFlush = async (previous: ErrorHandler, error: unknown, isFatal: boolean | undefined, choice?: Promise<void>): Promise<void> => {
    if (choice) {
        await boundedWait(() => choice);
    }

    const { client } = state;

    if (client && state.isOn) {
        await boundedWait(() => client.flush());
    }

    previous(error, isFatal);
};

/**
 * Sends errors that reach React Native's global handler, scrubbed, then calls the
 * handler that was there before (the red box in development, the crash in release).
 * Installed once, however many times the root mounts.
 */
export const installGlobalErrorReporting = (): void => {
    if (state.isHandlerInstalled) {
        return;
    }

    state.isHandlerInstalled = true;

    const previous: ErrorHandler = ErrorUtils.getGlobalHandler();

    ErrorUtils.setGlobalHandler((error, isFatal) => {
        try {
            const held: HeldReport = { fatal: isFatal === true, report: toCrashReport(error) };

            if (!state.isChoiceKnown) {
                // The saved choice is not read yet, so the report waits for it. The newest are kept.
                state.held = [...state.held, held].slice(-MAX_HELD_REPORTS);
            } else if (state.isOn) {
                sendReport(held);
            }
        } catch {
            // A reporting failure must not hide the crash, so the original handler still runs below.
            console.warn("A crash report could not be sent.");
        }

        // The app ends after a fatal error, so its report gets a bounded moment to leave first. A report held before the
        // saved choice is known waits for that choice, which sends it when the choice is on.
        const choice = state.isChoiceKnown ? undefined : state.choiceSettled;

        if (isFatal === true && (choice || (state.isOn && state.client))) {
            endAfterFlush(previous, error, isFatal, choice);

            return;
        }

        previous(error, isFatal);
    });
};
