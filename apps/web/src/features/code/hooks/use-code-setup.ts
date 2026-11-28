import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import type { SetupDevice } from "@/features/onboarding/lib/setup-steps";
import { deriveSetupSteps } from "@/features/onboarding/lib/setup-steps";

/** `loading`: nothing to say yet. `needed`: a step is still open, or the check failed. `ready`: every step is done or skipped. */
export type CodeSetupState = "loading" | "needed" | "ready";

interface CodeSetupInput {
    devices: ReadonlyArray<SetupDevice> | undefined;
    devicesFailed: boolean;
    settingsFailed: boolean;
    /** `undefined`: the settings read has not answered. `null`: an account with no settings row. */
    skipped: { setupStepsSkipped?: ReadonlyArray<string> } | null | undefined;
}

export const codeSetupState = ({ devices, devicesFailed, settingsFailed, skipped }: CodeSetupInput): CodeSetupState => {
    // A failed read shows the checklist, which names the failure and offers a retry.
    if (devicesFailed || settingsFailed) {
        return "needed";
    }

    if (devices === undefined || skipped === undefined) {
        return "loading";
    }

    return deriveSetupSteps(devices, skipped?.setupStepsSkipped).some((step) => step.status === "todo") ? "needed" : "ready";
};

export const useCodeSetup = (devices: ReadonlyArray<SetupDevice> | undefined, devicesFailed: boolean): CodeSetupState => {
    const settings = useUserSettings();

    return codeSetupState({ devices, devicesFailed, settingsFailed: settings.isError, skipped: settings.data });
};
