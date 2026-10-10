/**
 * The e2e invitation route must not exist on a deployed Worker: minting an
 * invitation for any address is open registration. These pin the gate — every
 * condition is required on its own — and the deploy config it relies on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { TestInvitationEnvironment } from "./e2e-seed-http";
import { createTestInvitationHandler, E2E_INVITATIONS_PATH, isTestInvitationRouteEnabled } from "./e2e-seed-http";

vi.mock("../auth", () => {
    return {
        getAuth: () => {
            return {};
        },
    };
});

const TOKEN = "e2e-seed-token";
const LOCAL: TestInvitationEnvironment = { environment: "development", publicOrigin: "http://localhost:8788", token: TOKEN };

const DEFAULT_BODY = { email: "Someone@Example.com" };

const post = (body: unknown = DEFAULT_BODY, token: string | null = TOKEN): Request =>
    new Request(`http://localhost:8788${E2E_INVITATIONS_PATH}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...(token !== null && { authorization: `Bearer ${token}` }) },
        method: "POST",
    });

const makeHandler = (environment: TestInvitationEnvironment) => {
    const invite = vi.fn(async (email: string) => `token-for-${email}`);

    return { handler: createTestInvitationHandler({ environment: () => environment, invite }), invite };
};

describe(isTestInvitationRouteEnabled, () => {
    it("is on for a local development stack with a token", () => {
        expect(isTestInvitationRouteEnabled(LOCAL)).toBe(true);
        expect(isTestInvitationRouteEnabled({ ...LOCAL, publicOrigin: "http://127.0.0.1:8788" })).toBe(true);
    });

    it.each([
        ["production", { ...LOCAL, environment: "production" }],
        ["preview", { ...LOCAL, environment: "preview" }],
        ["ENVIRONMENT unset", { ...LOCAL, environment: "" }],
        ["a deployed origin", { ...LOCAL, publicOrigin: "https://api.neore.chat" }],
        // eslint-disable-next-line unicorn/prefer-https -- the look-alike of a plain-HTTP loopback origin is the case under test
        ["a look-alike host", { ...LOCAL, publicOrigin: "http://localhost.attacker.example" }],
        ["an unparsable origin", { ...LOCAL, publicOrigin: "localhost" }],
        ["no token", { ...LOCAL, token: "" }],
    ])("is off for %s", (_label, environment) => {
        expect(isTestInvitationRouteEnabled(environment)).toBe(false);
    });
});

describe(createTestInvitationHandler, () => {
    it("mints an invitation for the normalised address", async () => {
        const { handler, invite } = makeHandler(LOCAL);
        const response = await handler(post());

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toStrictEqual({ token: "token-for-someone@example.com" });
        expect(invite).toHaveBeenCalledWith("someone@example.com");
    });

    it("answers 404 in production even to the right token, and mints nothing", async () => {
        const { handler, invite } = makeHandler({ environment: "production", publicOrigin: "https://api.neore.chat", token: TOKEN });
        const response = await handler(post());

        expect(response.status).toBe(404);
        expect(invite).not.toHaveBeenCalled();
    });

    it("refuses a missing or wrong bearer", async () => {
        const { handler, invite } = makeHandler(LOCAL);

        const missing = await handler(post(undefined, null));
        const wrong = await handler(post(undefined, "wrong"));

        expect(missing.status).toBe(401);
        expect(wrong.status).toBe(401);
        expect(invite).not.toHaveBeenCalled();
    });

    it("refuses a body without an address", async () => {
        const { handler } = makeHandler(LOCAL);

        const empty = await handler(post({}));
        const malformed = await handler(post({ email: "not-an-address" }));

        expect(empty.status).toBe(400);
        expect(malformed.status).toBe(400);
    });
});

describe("the deploy never enables it", () => {
    const alchemy = readFileSync(path.resolve(import.meta.dirname, "../../../alchemy.run.ts"), "utf8");

    it("binds no E2E_SEED_TOKEN", () => {
        expect(alchemy).not.toContain("E2E_SEED_TOKEN");
    });

    it("sets ENVIRONMENT to production or preview, never development", () => {
        expect(alchemy).toContain('ENVIRONMENT: stage === "production" ? "production" : "preview"');
    });
});
