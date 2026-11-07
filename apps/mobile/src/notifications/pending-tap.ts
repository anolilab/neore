/**
 * Where a tapped notification wants to go, held until the app can go there. A tap can
 * arrive while the app is still on the sign-in screen (or signed out, on a cold start);
 * the sign-in gate then sends the person here instead of the chat list, so a single
 * ordered navigation replaces two that raced (the tap's push and the gate's replace).
 */

export type TapRoute = `/chat/${string}` | "/";

const pending: { route?: TapRoute } = {};

export const holdTapRoute = (route: TapRoute): void => {
    pending.route = route;
};

/** The held destination, once: whoever navigates takes it. */
export const takeTapRoute = (): TapRoute | undefined => {
    const { route } = pending;

    pending.route = undefined;

    return route;
};

/** Where the sign-in gate sends a person who just signed in: a tapped notification's chat, else the chat list. */
export const routeAfterSignIn = (): TapRoute => takeTapRoute() ?? "/";

/** Whether the hook may go to a held tap now; otherwise the sign-in gate takes it once signed in. */
export const canNavigateToTap = (input: { isOnSignIn: boolean; status: "loading" | "signed-in" | "signed-out" }): boolean =>
    input.status === "signed-in" && !input.isOnSignIn;

/**
 * Drops a held destination. Sign-out and an account switch call it: a chat the previous
 * account tapped must not be where the next person lands after signing in.
 */
export const clearTapRoute = (): void => {
    pending.route = undefined;
};
