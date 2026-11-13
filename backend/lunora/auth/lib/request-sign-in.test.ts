/** Which sign-in a request is placed by: the web app's session first, else an app grant's. */
import { describe, expect, it } from "vitest";

import { requestSignIn } from "./request-sign-in";

describe("requestSignIn", () => {
    it("takes the web app's session", () => {
        expect(requestSignIn({ grantSessionId: "grant-1", sessionId: "session-1" })).toBe("session-1");
    });

    it("takes an app grant's sign-in when there is no web session", () => {
        expect(requestSignIn({ grantSessionId: "grant-1" })).toBe("grant-1");
    });

    it("finds none for an identity that names neither, or no identity", () => {
        expect(requestSignIn({ userId: "user-1" })).toBeUndefined();
        expect(requestSignIn(null)).toBeUndefined();
        expect(requestSignIn({ sessionId: 42 })).toBeUndefined();
    });
});
