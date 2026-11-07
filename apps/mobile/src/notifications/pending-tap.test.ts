import { afterEach, describe, expect, it } from "vitest";

import { canNavigateToTap, clearTapRoute, holdTapRoute, routeAfterSignIn, takeTapRoute } from "./pending-tap";

afterEach(() => {
    takeTapRoute();
});

describe("a tapped notification's destination", () => {
    it("is where the sign-in gate sends a person who just signed in, instead of the chat list", () => {
        holdTapRoute("/chat/t1");

        expect(routeAfterSignIn()).toBe("/chat/t1");
        // Taken once: the next sign-in goes to the chat list again.
        expect(routeAfterSignIn()).toBe("/");
    });

    it("is gone to at once only when signed in and past the sign-in screen", () => {
        expect(canNavigateToTap({ isOnSignIn: false, status: "signed-in" })).toBe(true);
        expect(canNavigateToTap({ isOnSignIn: true, status: "signed-in" })).toBe(false);
        expect(canNavigateToTap({ isOnSignIn: false, status: "signed-out" })).toBe(false);
        expect(canNavigateToTap({ isOnSignIn: false, status: "loading" })).toBe(false);
    });

    it("keeps the latest tap when two arrive before the app could navigate", () => {
        holdTapRoute("/chat/t1");
        holdTapRoute("/chat/t2");

        expect(takeTapRoute()).toBe("/chat/t2");
        expect(takeTapRoute()).toBeUndefined();
    });

    it("is dropped on sign-out or an account switch, so the next person lands on the chat list", () => {
        holdTapRoute("/chat/previous-account-chat");
        clearTapRoute();

        expect(routeAfterSignIn()).toBe("/");
    });
});
