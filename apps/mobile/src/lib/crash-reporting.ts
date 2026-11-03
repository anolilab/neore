import { PostHog } from "posthog-react-native";

import type { PostHogConfig } from "./config";
import type { PreferenceStore } from "./crash-report-preference";
import { readCrashReportsEnabled } from "./crash-report-preference";
import { toCrashReport } from "./crash-report-scrub";

const state: { client?: PostHog; isHandlerInstalled: boolean } = { isHandlerInstalled: false };

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

/** Applies the user's choice to the running client. Does nothing before `startCrashReporting`. */
export const setCrashReportsOn = async (isOn: boolean): Promise<void> => {
    if (!state.client) {
        return;
    }

    if (isOn) {
        await state.client.optIn();

        return;
    }

    await state.client.optOut();
};

/** Applies the stored choice at startup. A store that cannot be read leaves reports off. */
export const applyStoredCrashReportChoice = async (store: PreferenceStore): Promise<void> => {
    try {
        await setCrashReportsOn(await readCrashReportsEnabled(store));
    } catch {
        // Nothing was sent: the client starts opted out.
    }
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

    const previous = ErrorUtils.getGlobalHandler();

    ErrorUtils.setGlobalHandler((error, isFatal) => {
        const report = toCrashReport(error);
        // The SDK reads `name` and `stack` from the error. The message stays empty, so no user text is sent.
        // eslint-disable-next-line unicorn/no-error-property-assignment, unicorn/error-message -- the fields are the scrubbed report
        const sendable = Object.assign(new Error(""), { name: report.name, stack: report.stack });

        state.client?.captureException(sendable, { fatal: isFatal === true });
        previous(error, isFatal);
    });
};
