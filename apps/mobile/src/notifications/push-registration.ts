/**
 * Push on this phone, without the platform or the server: both are handed in, so the
 * order of the steps is testable. The glue is `phone-push.ts`.
 *
 * The phone's Expo push token is registered under the signed-in account on every
 * sign-in, whenever the OS rotates it, and each time the app comes back to the front.
 * The server moves a token to whoever registers it last, so a second account on the
 * same phone takes the pushes over from the first, and a phone whose token someone
 * else registered gets it back the next time it is opened.
 */

export type PhonePlatform = "android" | "ios";

export interface PushPermission {
    canAskAgain: boolean;
    granted: boolean;
}

export interface PushPlatform {
    /** False when this build cannot get a push token at all (no Expo project id, or Android without the Firebase file). */
    canReceivePush: boolean;
    getDeviceToken: () => Promise<string>;
    getPermission: () => Promise<PushPermission>;
    platform: PhonePlatform;
    /** Shows the system prompt. Resolves whether push was allowed. */
    requestPermission: () => Promise<boolean>;
}

export interface PushServer {
    /** Whether the server pushes to phones at all (its Expo access token is set). */
    isEnabled: () => Promise<boolean>;
    /** `language`: the phone's, so the server words the generic alert in it. */
    register: (platform: PhonePlatform, token: string, language: string | undefined) => Promise<boolean>;
    unregister: (token: string) => Promise<void>;
}

/**
 * Registers this phone for the signed-in account. Asks for permission only when
 * `canPrompt` is set (the person just did something worth being told about) and the
 * server can push to this platform, so nobody is asked for a permission that would
 * do nothing. Resolves the registered token, or `undefined`.
 *
 * `isCurrent` is asked right before the token is sent: a registration started for
 * an account that has since signed out (or been replaced) must not reach the server,
 * where it would move the phone back to that account.
 */
export const registerPhoneForPush = async ({
    canPrompt,
    isCurrent = () => true,
    language,
    platform,
    server,
}: {
    canPrompt: boolean;
    isCurrent?: () => boolean;
    language?: string;
    platform: PushPlatform;
    server: PushServer;
}): Promise<string | undefined> => {
    if (!platform.canReceivePush) {
        return undefined;
    }

    const isEnabled = await server.isEnabled();

    if (!isEnabled) {
        return undefined;
    }

    // A sign-out that began meanwhile: no prompt for an account that is leaving.
    if (!isCurrent()) {
        return undefined;
    }

    const permission = await platform.getPermission();
    // Asked again right before the prompt: a sign-out can begin while the permission is read.
    const isAllowed = permission.granted || (canPrompt && permission.canAskAgain && isCurrent() && await platform.requestPermission());

    if (!isAllowed) {
        return undefined;
    }

    const token = await platform.getDeviceToken();

    if (!isCurrent()) {
        return undefined;
    }

    const isRegistered = await server.register(platform.platform, token, language);

    return isRegistered ? token : undefined;
};

/**
 * Sign-out: the account stops getting pushes on this phone, unless `isCurrent` says
 * the sign-out is over by the time the token is known. Released whatever the
 * permission says now: a person who turned notifications off in the system settings
 * after registering still has a row on the server. A build that cannot receive push
 * registered nothing, so it releases nothing. A failure to get the token is not
 * swallowed: sign-out logs it, and the server stops sending once the session is revoked.
 */
export const releasePhonePush = async ({
    isCurrent = () => true,
    platform,
    server,
}: {
    isCurrent?: () => boolean;
    platform: PushPlatform;
    server: PushServer;
}): Promise<void> => {
    if (!platform.canReceivePush) {
        return;
    }

    const token = await platform.getDeviceToken();

    // A release that outlived its sign-out (it timed out and the next account signed in) would unregister THAT
    // account's row: the client now carries its sign-in.
    if (!isCurrent()) {
        return;
    }

    await server.unregister(token);
};

/**
 * Registrations, gated on the session. Sign-out `close`s the gate and then `settle`s:
 * a registration already on its way is let finish, and one still before its send, or
 * started later (a chat send that finishes during sign-out), finds `isCurrent` false
 * and never reaches the server, where it would give the phone back to the account
 * that just left. The next sign-in `open`s the gate again.
 */
export const createPendingWork = () => {
    const pending = new Set<Promise<unknown>>();
    const gate = { generation: 0, isClosed: false };

    return {
        /** Closes the gate. The guard it returns holds until the next `open` (a new sign-in) or `close`. */
        close: (): () => boolean => {
            gate.isClosed = true;
            gate.generation += 1;

            const { generation } = gate;

            return () => gate.isClosed && gate.generation === generation;
        },
        // A new generation: work started while the gate was closed stays refused after it reopens.
        open: (): void => {
            gate.isClosed = false;
            gate.generation += 1;
        },
        run: async <T>(work: (isCurrent: () => boolean) => Promise<T>): Promise<T> => {
            const { generation } = gate;
            const job = work(() => !gate.isClosed && gate.generation === generation);

            pending.add(job);

            try {
                return await job;
            } finally {
                pending.delete(job);
            }
        },
        settle: async (): Promise<void> => {
            await Promise.allSettled(pending);
        },
    };
};

/**
 * Sign-out's release step: no registration may send the token from here on, one already on its way finishes first (so
 * it cannot land after the release and give the phone back to the leaving account), then the token is released.
 */
export const releaseOnSignOut = async ({
    platform,
    registrations,
    server,
}: {
    platform: PushPlatform;
    registrations: Pick<ReturnType<typeof createPendingWork>, "close" | "settle">;
    server: PushServer;
}): Promise<void> => {
    const isSigningOut = registrations.close();

    await registrations.settle();
    await releasePhonePush({ isCurrent: isSigningOut, platform, server });
};

/**
 * A setup step that runs until it has worked once. A failed attempt is not remembered
 * as done, so the next call (the app coming back to the front) tries again.
 */
export const onceItWorks = (step: () => Promise<void>): () => Promise<void> => {
    const state = { isDone: false };

    return async () => {
        if (state.isDone) {
            return;
        }

        await step();
        state.isDone = true;
    };
};

/** Language, then an optional script and region; anything after (variants, `-u-` extensions) is left off. */
const LANGUAGE_SCRIPT_REGION = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?(?:-|$)/iu;

/**
 * Language, script and region only (`de-AT`, `zh-Hans-CN`): the server checks the tag, and a full locale can carry
 * `-u-` extensions (calendar, numbering, hour cycle) it would refuse, which would fail the whole registration. A
 * pattern, not `Intl.Locale`, which not every JavaScript engine the app runs on has.
 */
export const languageTag = (locale: string): string | undefined => {
    const match = LANGUAGE_SCRIPT_REGION.exec(locale.replaceAll("_", "-"));

    if (!match) {
        return undefined;
    }

    const [, language, script, region] = match;

    return [language?.toLowerCase(), script, region?.toUpperCase()].filter(Boolean).join("-");
};

/**
 * Whether a device token event is a real rotation. Fetching the token fires the same event on both platforms, so the
 * first token seen is the app's own fetch and only a token that differs from the last one seen counts: registering on
 * every event would fetch the token again, fire the event again, and never stop.
 */
export const createTokenChangeFilter = (): (token: string) => boolean => {
    const seen: { token?: string } = {};

    return (token) => {
        const isRotation = seen.token !== undefined && seen.token !== token;

        seen.token = token;

        return isRotation;
    };
};

/**
 * Registrations on coming back to the front, at most one per `intervalMs` after the last one that went through. One
 * that failed or sent nothing (offline, no permission yet) does not count, so the next return tries again; one still
 * on its way holds the others off.
 */
export const createForegroundGate = (intervalMs: number, now: () => number = Date.now) => {
    const state = { isRunning: false, lastRegisteredAt: -Infinity };

    return {
        run: async (attempt: () => Promise<boolean>): Promise<void> => {
            if (state.isRunning || now() - state.lastRegisteredAt < intervalMs) {
                return;
            }

            state.isRunning = true;

            try {
                if (await attempt()) {
                    state.lastRegisteredAt = now();
                }
            } finally {
                state.isRunning = false;
            }
        },
    };
};

/**
 * Who may be offered the permission prompt: the account signed in now, once per sign-in. `claim` is the offer for
 * `userId` (false for any other account, or one already offered); `release` reopens a failed one, but only while that
 * account is still the one signed in; `end` is the moment its sign-out begins.
 */
export const createPromptOffer = () => {
    const state: { isOffered: boolean; userId?: string } = { isOffered: false };

    return {
        begin: (userId: string): void => {
            state.isOffered = false;
            state.userId = userId;
        },
        claim: (userId: string): boolean => {
            if (state.userId !== userId || state.isOffered) {
                return false;
            }

            state.isOffered = true;

            return true;
        },
        end: (): void => {
            delete state.userId;
        },
        release: (userId: string): void => {
            if (state.userId === userId) {
                state.isOffered = false;
            }
        },
    };
};

/** A one-way digest of the account last signed in on this phone, kept across launches so a switch after a relaunch is seen too. */
export const LAST_ACCOUNT_KEY = "neore.mobile.last-push-account";

/** Written when the alerts of the account on record could not be removed: the next sign-in removes them, whoever it is. */
export const PENDING_REMOVAL = "pending-removal";

/**
 * Records the account signed in on this phone. Unless the record already names this account, the alerts still on the phone
 * may be someone else's, and `removeSwitchedAlerts` removes them first. The record moves to this account only after that
 * succeeds; a failed removal marks it pending, so the next sign-in removes them again. Kept on the device, not in memory,
 * so it holds across a relaunch. Only a digest of the id is kept, and sign-out does not clear it.
 */
export const noteAccountOnPhone = async (
    userId: string,
    store: {
        digest: (value: string) => Promise<string>;
        read: (key: string) => Promise<string | null>;
        write: (key: string, value: string) => Promise<void>;
    },
    removeSwitchedAlerts: () => Promise<void>,
    isCurrent: () => boolean = () => true,
): Promise<void> => {
    const current = await store.digest(userId);
    const previous = await store.read(LAST_ACCOUNT_KEY) ?? undefined;

    if (previous === current || !isCurrent()) {
        return;
    }

    try {
        await removeSwitchedAlerts();
    } catch (error) {
        // Pending even when this check is no longer current: the next sign-in must remove the alerts whoever it is.
        await store.write(LAST_ACCOUNT_KEY, PENDING_REMOVAL);

        throw error;
    }

    if (isCurrent()) {
        await store.write(LAST_ACCOUNT_KEY, current);
    }
};

/**
 * Runs account checks one after another: a check starts only when the one before it has finished. A check that has not
 * finished after `timeoutMs` stops holding up the ones queued after it, so one hung check cannot keep every later
 * account's alerts and registration waiting. A check that fails or times out is reported through `warn`; the queue moves on either way.
 */
const runAfter = async (
    previous: Promise<void>,
    check: (isLive: () => boolean) => Promise<void>,
    timeoutMs: number,
    warn: (message: string, error: unknown) => void,
): Promise<void> => {
    await previous;

    let isLive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        await Promise.race([
            check(() => isLive),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    isLive = false;
                    reject(new Error("Timed out"));
                }, timeoutMs);
            }),
        ]);
    } catch (error) {
        warn("A check of this phone's notifications did not finish, so it was skipped.", error);
    } finally {
        clearTimeout(timer);
    }
};

export const createAccountChecks = (timeoutMs: number, warn: (message: string, error: unknown) => void) => {
    let last: Promise<void> = Promise.resolve();

    return {
        run: (check: (isLive: () => boolean) => Promise<void>): void => {
            last = runAfter(last, check, timeoutMs, warn);
        },
        /** Resolves once every check queued so far has finished or timed out. */
        settled: (): Promise<void> => last,
    };
};
