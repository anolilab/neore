import type { HttpHandler } from "msw";
import { http, HttpResponse } from "msw";

import { DAY, STORY_NOW as NOW } from "../clock";

export interface SignInMethodsFixture {
    inviteOnly?: boolean;
    passkey?: boolean;
    social?: string[];
}

/**
 * What the sign-in pages read: which providers the backend offers and whether registration is open
 * (`GET /api/auth/sign-in-methods`). The default is the public deployment: GitHub, Google and passkeys.
 */
export const signInMethodsHandlers = ({ inviteOnly = false, passkey = true, social = ["github", "google"] }: SignInMethodsFixture = {}): HttpHandler[] => [
    http.get("*/api/auth/sign-in-methods", () => HttpResponse.json({ inviteOnly, oidc: null, passkey, social })),
];

export const INVITATION_ID = "inv_acme_member";

/** An organization invitation as better-auth's `GET /api/auth/organization/get-invitation` returns it. */
export const invitationHandlers = (): HttpHandler[] => [
    http.get("*/api/auth/organization/get-invitation", () =>
        HttpResponse.json({
            email: "free@neore.test",
            expiresAt: new Date(NOW + 5 * DAY).toISOString(),
            id: INVITATION_ID,
            inviterEmail: "ada@neore.test",
            organizationId: "org_acme",
            organizationName: "Acme Research",
            organizationSlug: "acme-research",
            role: "member",
            status: "pending",
        }),
    ),
];

export const DEVICE_CODE = "23456789";

/** `GET /api/auth/device?user_code=…`: a computer asking to be paired, or a code the server refuses. */
export const deviceCodeHandlers = (answer: "invalid" | "pending" = "pending"): HttpHandler[] => [
    http.get("*/api/auth/device", () => {
        if (answer === "invalid") {
            return HttpResponse.json({ error: "invalid_request", error_description: "Invalid user code" }, { status: 400 });
        }

        return HttpResponse.json({ client_id: "neore-host", hostname: "ada-workstation", platform: "linux", status: "pending", storage: "keychain" });
    }),
];
