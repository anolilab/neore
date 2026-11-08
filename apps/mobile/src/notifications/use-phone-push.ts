import { addPushTokenListener } from "expo-notifications";
import { useEffect } from "react";
import { AppState } from "react-native";

import { useAuth } from "../auth/auth-state";
import { getClient } from "../lib/lunora";
import { backendPushServer, configurePhoneNotifications, deviceLocale, devicePushPlatform } from "./phone-push";
import { createForegroundGate, createTokenChangeFilter, registerPhoneForPush } from "./push-registration";

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
 * Sends the token only while `isAccountCurrent` holds (the screen's account has not changed). A registration still on
 * its way when the account signs out is refused by the server: the session it carries is revoked by then.
 */
const register = async (canPrompt: boolean, isAccountCurrent: () => boolean = () => true): Promise<RegisterResult> => {
    try {
        const token = await registerPhoneForPush({
            canPrompt,
            isCurrent: isAccountCurrent,
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
};

const offer = { isDone: false };

/** Whether the account signed in when the offer was made is still the one signed in; false while nobody is. */
const signedIn = { isCurrent: (): boolean => false };

/** Coming back to the front often (closing the notification shade, the permission prompt) registers at most this often. */
export const FOREGROUND_REGISTER_INTERVAL_MS = 60_000;

/**
 * The moment to ask: the person just sent a message, so a reply, a question or an approval may come while the app is
 * in the background. Asked at most once per sign-in; the system itself shows its prompt only once. An attempt that
 * failed (offline, the server did not answer) leaves the offer open for the next message.
 */
export const offerPhonePush = async (): Promise<void> => {
    if (offer.isDone) {
        return;
    }

    offer.isDone = true;

    const { isCurrent } = signedIn;
    const { didRun } = await register(true, isCurrent);

    if (!didRun) {
        offer.isDone = false;
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

        // A new sign-in is offered the prompt again. Its registration counts toward the foreground spacing.
        offer.isDone = false;
        signedIn.isCurrent = isCurrent;
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
            signedIn.isCurrent = () => false;
            tokenSubscription.remove();
            appStateSubscription.remove();
        };
    }, [userId]);
};
