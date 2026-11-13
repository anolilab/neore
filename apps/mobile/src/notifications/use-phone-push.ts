import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { addPushTokenListener } from "expo-notifications";
import { useEffect } from "react";
import { AppState } from "react-native";

import { useAuth } from "../auth/auth-state";
import { getClient } from "../lib/lunora";
import { listenForApprovalTaps } from "./approval-actions";
import {
    backendPushServer,
    configurePhoneNotifications,
    deviceLocale,
    devicePushPlatform,
    dismissAccountNotifications,
    noteSignedInAccount,
    pushRegistrations,
    syncApprovalActions,
} from "./phone-push";
import { createAccountChecks, createForegroundGate, createPromptOffer, createTokenChangeFilter, registerPhoneForPush } from "./push-registration";

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

const setup = { inFlight: undefined as Promise<boolean> | undefined };

/** Registers the approval actions in the current language, unless they already are; a failure is logged and reported as `false`. */
const syncActionsNow = async (): Promise<boolean> => {
    try {
        await syncApprovalActions();

        return true;
    } catch (error: unknown) {
        // eslint-disable-next-line no-console -- no logger in the app; a failed setup must not be silent
        console.warn("Could not set up notifications.", error);

        return false;
    }
};

const attemptSetUp = async (): Promise<boolean> => {
    try {
        await configurePhoneNotifications();

        return true;
    } catch (error: unknown) {
        // eslint-disable-next-line no-console -- no logger in the app; a failed setup must not be silent
        console.warn("Could not set up notifications.", error);

        return false;
    }
};

/**
 * The setup the approve and deny actions need. Concurrent callers share one attempt. A failed attempt is not remembered as done: the next
 * call tries again. `configurePhoneNotifications` runs once it has worked, so a retry after that costs nothing.
 */
const setUpNotifications = async (): Promise<boolean> => {
    setup.inFlight ??= attemptSetUp();

    const attempt = setup.inFlight;

    try {
        const isSetUp = await attempt;

        if (!isSetUp) {
            return false;
        }

        // The actions are checked against the current language, and registered again when it changed, before any registration
        // proceeds. This is the only place the sync runs, so it runs once per setup.
        return await syncActionsNow();
    } finally {
        if (setup.inFlight === attempt) {
            setup.inFlight = undefined;
        }
    }
};

/** How long an account check may hold up the checks and registrations queued after it. */
const ACCOUNT_CHECK_TIMEOUT_MS = 5000;

const accountChecks = createAccountChecks(ACCOUNT_CHECK_TIMEOUT_MS);

/**
 * Another person signed in on this phone, now or before a relaunch: the alerts still on it are the previous account's,
 * and are removed. A check for an account that has already left does nothing. A phone that stays with one account keeps
 * its alerts. Every registration waits for the checks queued before it (`registerAfterSetUp`), so the new account's own
 * alerts cannot be removed after they arrive.
 */
const checkAccount = (userId: string, isCurrent: () => boolean): void => {
    accountChecks.run(async () => {
        if (!isCurrent()) {
            return;
        }

        try {
            await noteSignedInAccount(userId, dismissAccountNotifications);
        } catch (error) {
            // eslint-disable-next-line no-console -- no logger in the app; alerts that could not be removed must not be silent
            console.warn("Could not remove the previous account's notifications.", error);
        }
    });
};

/** A registration that waits for the setup first: it does not register a phone whose alerts would lack their actions. */
const registerAfterSetUp = async (isPrompt: boolean, isCurrent: () => boolean): Promise<Awaited<ReturnType<typeof register>>> => {
    // A setup that failed does not stop the registration: without one the phone gets no alerts at all, where an alert without its
    // buttons still opens the app. The setup is tried again at the next registration.
    await accountChecks.settled();
    await setUpNotifications();

    return await register(isPrompt, isCurrent);
};

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
    const { didRun } = await registerAfterSetUp(true, () => account?.isCurrent === true);

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

    // Set up early, so an alert that arrives as the phone registers already carries its approve and deny actions. Every
    // registration tries the same setup first (`registerAfterSetUp`).
    useEffect(() => {
        setUpNotifications();
    }, []);

    useEffect(() => {
        if (userId === undefined) {
            return undefined;
        }

        // A tap on an approval alert answers it as the signed-in account, through the procedure the chat's own card uses.
        // Offline it is refused, never queued (`onlineOnly`). Once that account's sign-out has begun, no tap is answered: the
        // answer reports that it was skipped, so the tap is not recorded as answered and can be read again.
        const subscription = listenForApprovalTaps(async (answer) => {
            if (signedIn.account?.isCurrent !== true) {
                return false;
            }

            await getClient().mutation(
                api.chat.tool_permissions.respondToToolApproval,
                { approvalId: answer.approvalId, decision: answer.decision, threadId: answer.threadId as Id<"threads"> },
                { onlineOnly: true },
            );

            return true;
        });

        return () => {
            subscription.remove();
        };
    }, [userId]);

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
            const { isRegistered } = await registerAfterSetUp(false, isCurrent);

            return isRegistered;
        };

        // A new sign-in reopens the gate the last sign-out closed and is offered the prompt again. Its registration
        // counts toward the foreground spacing.
        checkAccount(userId, isCurrent);

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

            setUpNotifications();

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
