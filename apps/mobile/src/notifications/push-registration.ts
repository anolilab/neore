/**
 * Push on this phone, without the platform or the server: both are handed in, so the
 * order of the steps is testable. The glue is `phone-push.ts`.
 *
 * The phone's Expo push token is registered under the signed-in account on every
 * sign-in (and whenever the OS rotates it). The server moves a token to whoever
 * registers it last, so a second account on the same phone takes the pushes over from
 * the first.
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
    register: (platform: PhonePlatform, token: string) => Promise<boolean>;
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
    platform,
    server,
}: {
    canPrompt: boolean;
    isCurrent?: () => boolean;
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

    const permission = await platform.getPermission();
    const isAllowed = permission.granted || (canPrompt && permission.canAskAgain && await platform.requestPermission());

    if (!isAllowed) {
        return undefined;
    }

    const token = await platform.getDeviceToken();

    if (!isCurrent()) {
        return undefined;
    }

    const isRegistered = await server.register(platform.platform, token);

    return isRegistered ? token : undefined;
};

/**
 * Sign-out: the account stops getting pushes on this phone, unless `isCurrent` says
 * the sign-out is over by the time the token is known. Released whatever the
 * permission says now: a person who turned notifications off in the system settings
 * after registering still has a row on the server. A phone the system gives no token
 * has nothing registered to release.
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
    let token: string;

    try {
        token = await platform.getDeviceToken();
    } catch {
        return;
    }

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
        open: (): void => {
            gate.isClosed = false;
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

/**
 * The sign-in registrations of one account. `run` registers now (sign-in, token
 * rotation); `retry` registers again only while the phone is not registered yet: no
 * network at launch, or notifications turned on in the system settings since. Only
 * the newest attempt decides: an older one finishing late cannot hide a newer token
 * that failed.
 */
export const createRegistrationRetry = (attempt: () => Promise<boolean>) => {
    const state = { isRegistered: false, latest: 0 };

    const run = async (): Promise<void> => {
        state.latest += 1;

        const mine = state.latest;
        const isRegistered = await attempt();

        if (mine === state.latest) {
            state.isRegistered = isRegistered;
        }
    };

    return {
        retry: async (): Promise<void> => {
            if (!state.isRegistered) {
                await run();
            }
        },
        run,
    };
};

/**
 * Whether the account signed in on the phone changed from one person to another. The
 * notifications already on the phone are the previous person's, so they are removed.
 */
export const isAccountSwitch = (previous: string | undefined, next: string | undefined): boolean =>
    previous !== undefined && next !== undefined && previous !== next;

/** The opaque ids a phone push carries; never any text. */
export interface PushIds {
    notificationId: string;
    threadId?: string;
}

const ID = /^[\w-]{1,64}$/u;

const parseJson = (value: string): unknown => {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
};

/**
 * The ids in a push, wherever the platform and the notification library put them:
 * the parsed `data`, Expo's `body` key in an APNs payload, an FCM message's `data`,
 * or a background task's `dataString`. Anything that is not an id is ignored.
 */
export const pushIdsIn = (value: unknown, depth = 0): PushIds | undefined => {
    if (typeof value === "string") {
        return depth < 4 ? pushIdsIn(parseJson(value), depth + 1) : undefined;
    }

    if (typeof value !== "object" || !value || depth > 4) {
        return undefined;
    }

    const { body, data, dataString, notificationId, threadId } = value as { body?: unknown; data?: unknown; dataString?: unknown; notificationId?: unknown; threadId?: unknown };

    if (typeof notificationId === "string" && ID.test(notificationId)) {
        return { notificationId, ...typeof threadId === "string" && ID.test(threadId) && { threadId } };
    }

    return pushIdsIn(data, depth + 1) ?? pushIdsIn(dataString, depth + 1) ?? pushIdsIn(body, depth + 1);
};

/** The ids of a delivered or tapped notification: its content, or the raw push it came from. */
export const pushIdsFromNotification = (request: { content: { data?: unknown }; trigger?: unknown }): PushIds | undefined => {
    const trigger = (request.trigger ?? {}) as { payload?: unknown; remoteMessage?: unknown };

    return pushIdsIn(request.content.data) ?? pushIdsIn(trigger.payload) ?? pushIdsIn(trigger.remoteMessage);
};

/** The screen a tapped notification opens: its chat, or the chat list. */
export const routeForPush = (ids: PushIds | undefined): `/chat/${string}` | "/" => {
    if (ids?.threadId === undefined) {
        return "/";
    }

    return `/chat/${ids.threadId}`;
};
