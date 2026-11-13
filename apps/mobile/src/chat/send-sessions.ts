/** One send's place in the signed-in session. */
export interface SendSession {
    /** The send settled: sign-out no longer needs to stop it. */
    end: () => void;
    /** A sign-out came since the send began: its prompt and held id are the departed account's, and are dropped. */
    isSignedOut: () => boolean;
}

/**
 * The sends of the signed-in session. A send keeps retrying with the token it fetched (`startWithRetries`), and ending
 * the auth epoch stops no request, so sign-out stops every send still going (`signOut`): a retry can never save a message
 * for an account that is gone. A send stopped that way goes through the stopped-send path but gives nothing back. The
 * sessions stay closed until the next sign-in (`open`): a send begun during the sign-out's teardown, while the account
 * still reads as signed in, is stopped at once and counts as signed out too.
 */
export const createSendSessions = () => {
    let session = 0;
    let isClosed = false;
    const controllers = new Set<AbortController>();

    return {
        begin: (controller: AbortController): SendSession => {
            // A send begun while a sign-out runs belongs to the departing account: stopped, and never its own session.
            const startedIn = isClosed ? -1 : session;

            if (isClosed) {
                controller.abort();
            }

            controllers.add(controller);

            return {
                end: () => {
                    controllers.delete(controller);
                },
                isSignedOut: () => startedIn !== session,
            };
        },
        /** At a sign-in: sends begin normally again. */
        open: (): void => {
            isClosed = false;
        },
        signOut: (): void => {
            session += 1;
            isClosed = true;

            for (const controller of controllers) {
                controller.abort();
            }

            controllers.clear();
        },
    };
};

/** The app's one registry: the chat screen registers each send, and sign-out stops them. */
export const sendSessions = createSendSessions();
