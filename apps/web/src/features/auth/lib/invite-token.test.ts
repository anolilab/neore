import { createAuthClient } from "better-auth/react";
import { describe, expect, it } from "vitest";

import { parseInviteToken, withInviteToken } from "./invite-token";

describe("parseInviteToken", () => {
    it("reads the token", () => {
        expect(parseInviteToken("?invite=abc123")).toBe("abc123");
    });

    it("reads it alongside other parameters, in any position", () => {
        expect(parseInviteToken("?redirect=%2Fchat&invite=abc123")).toBe("abc123");
    });

    it("url-decodes the value", () => {
        expect(parseInviteToken("?invite=a%2Bb%2Fc")).toBe("a+b/c");
    });

    it.each(["", "?", "?other=1", "?invite=", "?invite=%20%20"])("returns undefined for %o rather than an empty token", (search) => {
        // An empty `inviteToken` is rejected as INVALID, which reads worse to the
        // user than simply not sending one.
        expect(parseInviteToken(search)).toBeUndefined();
    });

    it("trims surrounding whitespace", () => {
        expect(parseInviteToken("?invite=%20abc%20")).toBe("abc");
    });
});

describe("withInviteToken", () => {
    it("adds the token when one is supplied", () => {
        expect(withInviteToken({ email: "a@b.test" }, "tok")).toStrictEqual({ email: "a@b.test", inviteToken: "tok" });
    });

    it("leaves the payload untouched when there is none, rather than sending an empty field", () => {
        const payload = { email: "a@b.test" };

        expect(withInviteToken(payload, undefined)).toStrictEqual(payload);
    });

    it("does not mutate the payload it is given", () => {
        const payload = { email: "a@b.test" };

        withInviteToken(payload, "tok");

        expect(payload).toStrictEqual({ email: "a@b.test" });
    });
});

describe("the token actually reaches the sign-up request body", () => {
    /**
     * `withInviteToken` adds a field better-auth's generated types do not know
     * about, so the only thing that proves it survives is a real client call.
     * better-auth's proxy destructures `{ query, fetchOptions, ...body }` and
     * forwards the rest verbatim — this pins that, rather than trusting the read.
     */
    const captureSignUpBody = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
        let captured: Record<string, unknown> = {};

        const client = createAuthClient({
            baseURL: "https://auth.test",
            fetchOptions: {
                customFetchImpl: async (_input, init) => {
                    captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

                    return Response.json({ token: "t", user: {} }, { headers: { "content-type": "application/json" }, status: 200 });
                },
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the payload deliberately carries a field the generated type has no slot for
        await client.signUp.email(payload as any);

        return captured;
    };

    it("sends inviteToken when the visitor arrived on an invitation link", async () => {
        const body = await captureSignUpBody(withInviteToken({ email: "a@b.test", name: "A", password: "hunter2hunter2" }, "tok-123"));

        expect(body["inviteToken"]).toBe("tok-123");
        expect(body["email"]).toBe("a@b.test");
    });

    it("sends no inviteToken key at all when there is no invitation", async () => {
        const body = await captureSignUpBody(withInviteToken({ email: "a@b.test", name: "A", password: "hunter2hunter2" }, undefined));

        expect(body).not.toHaveProperty("inviteToken");
    });

    it("keeps fetchOptions out of the body while still sending the token", async () => {
        // The anonymous-conversion dialog passes `fetchOptions` inside the same
        // object, so the two must not collide.
        const body = await captureSignUpBody(
            withInviteToken({ email: "a@b.test", fetchOptions: { throw: true }, name: "A", password: "hunter2hunter2" }, "tok-123"),
        );

        expect(body["inviteToken"]).toBe("tok-123");
        expect(body).not.toHaveProperty("fetchOptions");
    });
});
