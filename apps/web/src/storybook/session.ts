import type { HttpHandler } from "msw";
import { http, HttpResponse } from "msw";

/**
 * Who is signed in, for Storybook. `get-session` is answered by MSW, so a persona is
 * nothing but a different response: better-auth's session atom, the `["session"]`
 * query and Lunora's identity probe all read the same handler (`*` matches both the
 * Storybook origin and `VITE_LUNORA_URL`).
 */
export type Persona = "admin" | "free" | "guest" | "org-member" | "pro" | "signed-out";

/** The organization the `org-member` persona has active. */
export const ORGANIZATION = { id: "org_acme", logo: null, name: "Acme Research", slug: "acme-research" } as const;

const CREATED_AT = "2026-01-15T09:00:00.000Z";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

type SignedIn = Exclude<Persona, "signed-out">;

const NAMES: Record<SignedIn, string> = {
    admin: "Grace Hopper",
    free: "Sam Rivera",
    guest: "Guest",
    "org-member": "Alan Turing",
    pro: "Ada Lovelace",
};

const user = (persona: SignedIn) => {
    const isAnonymous = persona === "guest";

    return {
        createdAt: CREATED_AT,
        email: isAnonymous ? "guest-7f3a@anonymous.neore.test" : `${persona}@neore.test`,
        emailVerified: !isAnonymous,
        id: `user_${persona}`,
        image: null,
        isAnonymous,
        name: NAMES[persona],
        role: persona === "admin" ? "admin" : "user",
        updatedAt: CREATED_AT,
    };
};

export const sessionFor = (persona: Persona) => {
    if (persona === "signed-out") {
        return null;
    }

    const sessionUser = user(persona);

    return {
        session: {
            createdAt: CREATED_AT,
            expiresAt: EXPIRES_AT,
            activeOrganizationId: persona === "org-member" ? ORGANIZATION.id : null,
            id: `session_${persona}`,
            token: `storybook-${persona}`,
            updatedAt: CREATED_AT,
            userId: sessionUser.id,
        },
        user: sessionUser,
    };
};

/** The persona of the story on screen, which the session handlers answer as. */
const active: { persona: Persona } = { persona: "pro" };

export const getActivePersona = (): Persona => active.persona;

/** Set by a preview loader from the story's `parameters.persona` or the toolbar, before the story renders. */
export const setActivePersona = (persona: Persona): void => {
    active.persona = persona;
};

/**
 * The better-auth endpoints the app calls on load, answering as the active persona. Other
 * `/api/auth/*` calls belong to the story that needs them (`apiKeyHandlers`).
 */
export const sessionHandlers = (): HttpHandler[] => {
    const current = () => sessionFor(active.persona);

    return [
        http.get("*/api/auth/get-session", () => HttpResponse.json(current())),
        // The sign-in UI asks which methods the deployment offers: email only, invite-only.
        http.get("*/api/auth/sign-in-methods", () =>
            HttpResponse.json({ inviteOnly: true, oidc: null, passkey: false, social: [] }),
        ),
        http.get("*/api/auth/token", () => {
            const session = current();

            return session ? HttpResponse.json({ token: session.session.token }) : HttpResponse.json(null, { status: 401 });
        }),
        http.get("*/api/auth/organization/list", () => {
            const session = current();

            return HttpResponse.json(session?.session.activeOrganizationId ? [{ ...ORGANIZATION, createdAt: CREATED_AT }] : []);
        }),
        // Only the `org-member` persona has an organization active.
        http.get("*/api/auth/organization/get-full-organization", () => {
            const session = current();

            if (!session?.session.activeOrganizationId) {
                return HttpResponse.json(null);
            }

            return HttpResponse.json({
                ...ORGANIZATION,
                createdAt: CREATED_AT,
                invitations: [],
                members: [
                    {
                        createdAt: CREATED_AT,
                        id: "member_owner",
                        organizationId: ORGANIZATION.id,
                        role: "owner",
                        user: { email: "owner@acme.test", id: "user_owner", image: null, name: "Katherine Johnson" },
                        userId: "user_owner",
                    },
                    {
                        createdAt: CREATED_AT,
                        id: "member_self",
                        organizationId: ORGANIZATION.id,
                        role: "member",
                        user: { email: session.user.email, id: session.user.id, image: null, name: session.user.name },
                        userId: session.user.id,
                    },
                ],
            });
        }),
    ];
};
