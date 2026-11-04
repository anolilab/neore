import type { PostHog } from "posthog-react-native";

import type { PreferenceStore } from "./crash-report-preference";
import { readCrashReportsEnabled, writeCrashReportsEnabled } from "./crash-report-preference";
import { toCrashReport } from "./crash-report-scrub";
import { createSerialQueue } from "./serial-queue";

/** The part of the SDK this module uses. A test can supply its own. */
export type CrashReportClient = Pick<PostHog, "captureException" | "optIn" | "optOut">;

const state: { client?: CrashReportClient; create?: () => CrashReportClient; isHandlerInstalled: boolean; isOn: boolean } = {
    isHandlerInstalled: false,
    isOn: false,
};

/**
 * Reads the saved choice and changes it. Both run one at a time, so a startup read
 * cannot apply an older choice after a newer one has been made.
 */
const runChoice = createSerialQueue();

/**
 * Records how to make the client. Nothing is made here: the client is made only when reporting is
 * first turned on, so a user who never opted in never loads the SDK.
 */
export const startCrashReporting = (create: () => CrashReportClient): void => {
    state.create = create;
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

/** Whether reports are being sent right now. Read through the queue, so it follows any change still in progress. */
export const crashReportsOn = (): Promise<boolean> => runChoice(async () => state.isOn);

/**
 * Changes the choice. The client is switched first, so an opt-out takes effect even
 * if saving the choice then fails.
 */
export const changeCrashReports = (store: PreferenceStore, isOn: boolean): Promise<void> =>
    runChoice(async () => {
        await applyToClient(isOn);
        await writeCrashReportsEnabled(store, isOn);
    });

/** Whether this install has been started before, and a way to mark that it has. */
export interface InstallMarker {
    create: () => void;
    exists: () => boolean;
}

/**
 * Applies the saved choice at startup. A store that cannot be read leaves reports off.
 * On a new install the saved choice is reset to off first: the Keychain can still hold a choice from an app
 * that was deleted, and nobody has agreed to that choice on this install. If the reset cannot be saved, the
 * client is not started, and the next launch tries again.
 */
export const applyStoredCrashReportChoice = (store: PreferenceStore, marker: InstallMarker): Promise<void> =>
    runChoice(async () => {
        if (!marker.exists()) {
            try {
                await writeCrashReportsEnabled(store, false);
                marker.create();
            } catch {
                console.warn("Could not reset the saved crash-report choice.");
            }

            return;
        }

        let isOn: boolean;

        try {
            isOn = await readCrashReportsEnabled(store);
        } catch {
            // Nothing was sent: the client starts opted out.
            return;
        }

        try {
            await applyToClient(isOn);
        } catch (applyError) {
            console.warn("Could not apply the crash-report setting.", applyError);
        }
    });

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

    const previous = ErrorUtils.getGlobalHandler();

    ErrorUtils.setGlobalHandler((error, isFatal) => {
        try {
            // Nothing is sent unless the applied choice is on, so an error is never handed to the SDK for a user who has not opted in.
            if (state.isOn) {
                const report = toCrashReport(error);
                // The SDK reads `name` and `stack` from the error. The message stays empty, so no user text is sent.
                // eslint-disable-next-line unicorn/no-error-property-assignment, unicorn/error-message -- the fields are the scrubbed report
                const sendable = Object.assign(new Error(""), { name: report.name, stack: report.stack });

                state.client?.captureException(sendable, { fatal: isFatal === true });
            }
        } catch {
            // A reporting failure must not hide the crash, so the original handler still runs below. The error itself
            // is not logged: its message and stack can hold chat text.
            console.warn("A crash report could not be sent.");
        }

        previous(error, isFatal);
    });
};
