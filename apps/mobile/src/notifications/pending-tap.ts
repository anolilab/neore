/**
 * Where a tapped notification wants to go, held until the app can go there. A tap can
 * arrive while the app is still on the sign-in screen (or signed out, on a cold start);
 * the sign-in gate then sends the person here instead of the chat list, so a single
 * ordered navigation replaces two that raced (the tap's push and the gate's replace).
 */

export type TapRoute = `/chat/${string}` | "/";

const pending: { route?: TapRoute; whileSignedOut?: boolean } = {};

/**
 * Holds a tapped notification's destination. `whileSignedOut`: nobody was signed in when it was tapped, so nothing
 * says it is the account that signs in next; it is not followed after sign-in (`routeAfterSignIn`).
 */
export const holdTapRoute = (route: TapRoute, { whileSignedOut = false }: { whileSignedOut?: boolean } = {}): void => {
    pending.route = route;
    pending.whileSignedOut = whileSignedOut;
};

/** The held destination, once: whoever navigates takes it. */
export const takeTapRoute = (): TapRoute | undefined => {
    const { route } = pending;

    pending.route = undefined;
    pending.whileSignedOut = undefined;

    return route;
};

/**
 * Where the sign-in gate sends a person who just signed in: a tapped notification's chat when it was tapped with a
 * session on the phone (the cold start of a signed-in account), else the chat list. A tap from the sign-in screen
 * may be the previous account's: following it would hand its chat id to whoever signs in.
 */
export const routeAfterSignIn = (): TapRoute => {
    const { whileSignedOut } = pending;
    const route = takeTapRoute();

    return whileSignedOut === true ? "/" : route ?? "/";
};

/** Whether the hook may go to a held tap now; otherwise the sign-in gate takes it once signed in. */
export const canNavigateToTap = (input: { isOnSignIn: boolean; status: "loading" | "signed-in" | "signed-out" }): boolean =>
    input.status === "signed-in" && !input.isOnSignIn;

/**
 * Drops a held destination. Sign-out and an account switch call it: a chat the previous
 * account tapped must not be where the next person lands after signing in.
 */
export const clearTapRoute = (): void => {
    pending.route = undefined;
    pending.whileSignedOut = undefined;
};
