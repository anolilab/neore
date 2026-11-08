import { addPushTokenListener } from "expo-notifications";
import { useEffect } from "react";
import { AppState } from "react-native";

import { useAuth } from "../auth/auth-state";
import { getClient } from "../lib/lunora";
import { backendPushServer, configurePhoneNotifications, deviceLocale, devicePushPlatform, pushRegistrations } from "./phone-push";
import { createForegroundGate, createPromptOffer, createTokenChangeFilter, registerPhoneForPush } from "./push-registration";

/** Push is best-effort: a failure is logged (never the token) and never breaks the screen that asked. */
const quietly = async (message: string, work: () => Promise<unknown>): Promise<void> => {
    try {
        await work();
    } catch (error) {
        // eslint-disable-next-line no-console -- no logger in the app; a failed setup must not be silent
        console.warn(message, error);
    }
};

/** `didRun`: no error (offline, no answer). `isRegistered`: the server now holds the token for this account. */
interface RegisterResult {
    didRun: boolean;
    isRegistered: boolean;
}

/**
 * Tracked, so sign-out can wait for it. It sends the token only while the session gate is open (sign-out closes it)
 * and `isAccountCurrent` holds (the account it registers for is still the one signed in).
 */
const register = async (canPrompt: boolean, isAccountCurrent: () => boolean = () => true): Promise<RegisterResult> =>
    await pushRegistrations.run(async (isSessionCurrent) => {
        try {
            const token = await registerPhoneForPush({
                canPrompt,
                isCurrent: () => isSessionCurrent() && isAccountCurrent(),
                language: deviceLocale(),
                platform: devicePushPlatform,
                server: backendPushServer(getClient()),
            });

            return { didRun: true, isRegistered: token !== undefined };
        } catch (error) {
            // eslint-disable-next-line no-console -- no logger in the app; a failed registration must not be silent
            console.warn("Could not register this phone for notifications.", error);

            return { didRun: false, isRegistered: false };
        }
    });

const promptOffer = createPromptOffer();

/** The signed-in account's registrations carry `isCurrent`; false while nobody is, or once its sign-out began. */
const signedIn: { account?: { isCurrent: boolean } } = {};

/** Sign-out has begun: no prompt and no registration, offered or in the background, for the account that is leaving. */
export const endPhonePushForAccount = (): void => {
    if (signedIn.account) {
        signedIn.account.isCurrent = false;
    }

    delete signedIn.account;
    promptOffer.end();
};

/** Coming back to the front often (closing the notification shade, the permission prompt) registers at most this often. */
export const FOREGROUND_REGISTER_INTERVAL_MS = 60_000;

/**
 * The moment to ask: `userId` just sent a message, so a reply, a question or an approval may come while the app is in
 * the background. Only while that account is still the one signed in, at most once per sign-in; the system itself
 * shows its prompt only once. An attempt that failed (offline, the server did not answer) leaves that account's offer
 * open for its next message.
 */
export const offerPhonePush = async (userId: string): Promise<void> => {
    if (!promptOffer.claim(userId)) {
        return;
    }

    const { account } = signedIn;
    const { didRun } = await register(true, () => account?.isCurrent === true);

    if (!didRun) {
        promptOffer.release(userId);
    }
};

/**
 * Registers this phone under the signed-in account: at sign-in, whenever the system rotates the token, and each time
 * the app comes back to the front. The last one keeps the phone registered when notifications were turned on in the
 * system settings since, and takes the phone back if someone registered its token from another account.
 */
export const usePhonePush = (): void => {
    const { hasToken, status, user } = useAuth();
    const userId = status === "signed-in" && hasToken ? user?.id : undefined;

    useEffect(() => {
        quietly("Could not set up notifications.", configurePhoneNotifications);
    }, []);

    useEffect(() => {
        if (userId === undefined) {
            return undefined;
        }

        // Keyed by the account: another account signing in registers the same token, which moves it to them.
        const account = { isCurrent: true };
        const isCurrent = () => account.isCurrent;
        const foreground = createForegroundGate(FOREGROUND_REGISTER_INTERVAL_MS);
        const isRotation = createTokenChangeFilter();
        const registerSilently = async (): Promise<boolean> => {
            const { isRegistered } = await register(false, isCurrent);

            return isRegistered;
        };

        // A new sign-in reopens the gate the last sign-out closed and is offered the prompt again. Its registration
        // counts toward the foreground spacing.
        pushRegistrations.open();
        signedIn.account = account;
        promptOffer.begin(userId);
        foreground.run(registerSilently);

        const tokenSubscription = addPushTokenListener(({ data }) => {
            if (typeof data === "string" && isRotation(data)) {
                registerSilently();
            }
        });
        const appStateSubscription = AppState.addEventListener("change", (state) => {
            if (state !== "active") {
                return;
            }

            quietly("Could not set up notifications.", configurePhoneNotifications);

            foreground.run(registerSilently);
        });

        return () => {
            account.isCurrent = false;
            endPhonePushForAccount();
            tokenSubscription.remove();
            appStateSubscription.remove();
        };
    }, [userId]);
};
