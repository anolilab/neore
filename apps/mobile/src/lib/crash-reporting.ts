import { PostHog } from "posthog-react-native";

import type { PostHogConfig } from "./config";
import type { PreferenceStore } from "./crash-report-preference";
import { readCrashReportsEnabled, writeCrashReportsEnabled } from "./crash-report-preference";
import { toCrashReport } from "./crash-report-scrub";
import { createSerialQueue } from "./serial-queue";

const state: { client?: PostHog; isHandlerInstalled: boolean; isOn: boolean } = { isHandlerInstalled: false, isOn: false };

/**
 * Reads the saved choice and changes it. Both run one at a time, so a startup read
 * cannot apply an older choice after a newer one has been made.
 */
const runChoice = createSerialQueue();

/**
 * Creates the SDK once. The client starts opted out, and it is built with no
 * automatic capture and no flag, remote-config or survey fetch, so nothing but a
 * crash the user has agreed to report reaches PostHog. `defaultOptIn: false` alone
 * still lets the core request feature flags on start, so those are turned off here.
 */
export const startCrashReporting = ({ apiKey, host }: PostHogConfig): void => {
    state.client ??= new PostHog(apiKey, {
        captureAppLifecycleEvents: false,
        defaultOptIn: false,
        disableRemoteFeatureFlags: true,
        disableSurveys: true,
        errorTracking: { autocapture: false },
        host,
        preloadFeatureFlags: false,
    });
};

/**
 * Turns the running client on or off. Does nothing before `startCrashReporting`. The
 * state is recorded only once the client has accepted the change, so it always
 * matches what the client does.
 */
const applyToClient = async (isOn: boolean): Promise<void> => {
    if (!state.client) {
        return;
    }

    if (isOn) {
        await state.client.optIn();
    } else {
        await state.client.optOut();
    }

    state.isOn = isOn;
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

/** Applies the saved choice at startup. A store that cannot be read leaves reports off. */
export const applyStoredCrashReportChoice = (store: PreferenceStore): Promise<void> =>
    runChoice(async () => {
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
            const report = toCrashReport(error);
            // The SDK reads `name` and `stack` from the error. The message stays empty, so no user text is sent.
            // eslint-disable-next-line unicorn/no-error-property-assignment, unicorn/error-message -- the fields are the scrubbed report
            const sendable = Object.assign(new Error(""), { name: report.name, stack: report.stack });

            state.client?.captureException(sendable, { fatal: isFatal === true });
        } catch {
            // A reporting failure must not hide the crash, so the original handler still runs below. The error itself
            // is not logged: its message and stack can hold chat text.
            console.warn("A crash report could not be sent.");
        }

        previous(error, isFatal);
    });
};
