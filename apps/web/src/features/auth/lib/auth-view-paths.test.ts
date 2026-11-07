import { afterEach, describe, expect, it } from "vitest";

import { authViewSearch } from "./auth-view-paths";

describe("authViewSearch", () => {
    afterEach(() => {
        globalThis.history.replaceState(null, "", "/");
    });

    it("keeps the current query when the form has no redirect", () => {
        globalThis.history.replaceState(null, "", "/auth/sign-in?invite=abc");

        expect(authViewSearch()).toBe("?invite=abc");
    });

    it("adds the chat the sign-in prompt was opened on, keeping the rest of the query", () => {
        globalThis.history.replaceState(null, "", "/chat/t1?invite=abc");

        const parameters = new URLSearchParams(authViewSearch("/chat/t1?invite=abc"));

        expect(parameters.get("redirectTo")).toBe("/chat/t1?invite=abc");
        expect(parameters.get("invite")).toBe("abc");
    });
});
