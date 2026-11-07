import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { addPushTokenListener, DEFAULT_ACTION_IDENTIFIER, dismissAllNotificationsAsync, useLastNotificationResponse } from "expo-notifications";
import { useRouter, useSegments } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useAuth } from "../auth/auth-state";
import { sharedKeychainOps } from "../auth/secure-store";
import { canClaimLaunchReopen } from "../chat/launch-reopen";
import { getClient } from "../lib/lunora";
import { canNavigateToTap, clearTapRoute, holdTapRoute, takeTapRoute } from "./pending-tap";
import { backendPushServer, configurePhoneNotifications, devicePushPlatform, pushRegistrations } from "./phone-push";
import { createRegistrationRetry, noteAccountOnPhone, pushIdsFromNotification, registerPhoneForPush, routeForPush } from "./push-registration";

/** Push is best-effort: a failure is logged and never breaks the screen that asked. */
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
 * and, when given, `isAccountCurrent` holds (the screen's account has not changed).
 */
const register = async (canPrompt: boolean, isAccountCurrent: () => boolean = () => true): Promise<RegisterResult> =>
    await pushRegistrations.run(async (isSessionCurrent) => {
        try {
            const token = await registerPhoneForPush({
                canPrompt,
                isCurrent: () => isSessionCurrent() && isAccountCurrent(),
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

const offer = { isDone: false };

/**
 * The moment to ask: the person just sent a message, so a reply, a question or an
 * approval may come while the app is in the background. Asked at most once a launch;
 * the system itself shows its prompt only once. An attempt that failed (offline, the
 * server did not answer) leaves the offer open for the next message.
 */
export const offerPhonePush = async (): Promise<void> => {
    if (offer.isDone) {
        return;
    }

    offer.isDone = true;

    const { didRun } = await register(true);

    if (!didRun) {
        offer.isDone = false;
    }
};

/**
 * Registers this phone under the signed-in account (again whenever the system
 * rotates the token), and opens the chat a tapped notification names.
 */
export const usePhonePush = (): void => {
    const { hasToken, status, user } = useAuth();
    const router = useRouter();
    const response = useLastNotificationResponse();
    const isOnSignIn = useSegments()[0] === "sign-in";
    const handled = useRef<string | undefined>(undefined);
    const userId = status === "signed-in" && hasToken ? user?.id : undefined;

    useEffect(() => {
        quietly("Could not set up notifications.", configurePhoneNotifications);
    }, []);

    useEffect(() => {
        if (userId === undefined) {
            return;
        }

        // Another person signed in on this phone, now or before a relaunch: the alerts still on it are the previous account's.
        quietly("Could not remove the previous account's notifications.", async () => {
            const isSwitch = await noteAccountOnPhone(userId, {
                ...sharedKeychainOps,
                digest: async (value) => await digestStringAsync(CryptoDigestAlgorithm.SHA256, value),
            });

            if (!isSwitch) {
                return;
            }

            clearTapRoute();
            await dismissAllNotificationsAsync();
        });
    }, [userId]);

    useEffect(() => {
        if (userId === undefined) {
            return undefined;
        }

        // Keyed by the account: another account signing in registers the same token, which moves it to them.
        const account = { isCurrent: true };
        const isCurrent = () => account.isCurrent;

        const registration = createRegistrationRetry(async () => {
            const { isRegistered } = await register(false, isCurrent);

            return isRegistered;
        });

        // A new sign-in reopens the gate the last sign-out closed.
        pushRegistrations.open();
        registration.run();

        const tokenSubscription = addPushTokenListener(() => {
            registration.run();
        });
        // A phone not registered yet (no network at launch, or notifications turned on in the system settings since)
        // tries again, silently, when the app comes back to the front; so does a notification setup that failed. A
        // registration that went through is not repeated.
        const appStateSubscription = AppState.addEventListener("change", (state) => {
            if (state !== "active") {
                return;
            }

            quietly("Could not set up notifications.", configurePhoneNotifications);

            registration.retry();
        });

        return () => {
            account.isCurrent = false;
            tokenSubscription.remove();
            appStateSubscription.remove();
        };
    }, [userId]);

    useEffect(() => {
        if (response?.actionIdentifier === DEFAULT_ACTION_IDENTIFIER && handled.current !== response.notification.request.identifier) {
            const { request } = response.notification;

            handled.current = request.identifier;
            // A launch from a notification opens its chat, not the one the launch would reopen.
            canClaimLaunchReopen();
            holdTapRoute(routeForPush(pushIdsFromNotification(request)), { whileSignedOut: status === "signed-out" });
        }

        // Still signing in (or on the sign-in screen): the sign-in gate goes there instead of the chat list.
        if (canNavigateToTap({ isOnSignIn, status })) {
            const route = takeTapRoute();

            if (route !== undefined) {
                router.push(route);
            }
        }
    }, [isOnSignIn, response, router, status]);
};
