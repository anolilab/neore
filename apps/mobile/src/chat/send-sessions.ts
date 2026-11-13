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
 * for an account that is gone. A send stopped that way goes through the stopped-send path but gives nothing back.
 */
export const createSendSessions = () => {
    let session = 0;
    const controllers = new Set<AbortController>();

    return {
        begin: (controller: AbortController): SendSession => {
            const startedIn = session;

            controllers.add(controller);

            return {
                end: () => {
                    controllers.delete(controller);
                },
                isSignedOut: () => startedIn !== session,
            };
        },
        signOut: (): void => {
            session += 1;

            for (const controller of controllers) {
                controller.abort();
            }

            controllers.clear();
        },
    };
};

/** The app's one registry: the chat screen registers each send, and sign-out stops them. */
export const sendSessions = createSendSessions();
