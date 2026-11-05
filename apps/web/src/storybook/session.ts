import type { HttpHandler } from "msw";
import { http, HttpResponse } from "msw";

/**
 * Who is signed in, for Storybook. `get-session` is answered by MSW, so a persona is
 * nothing but a different response: better-auth's session atom, the `["session"]`
 * query and Lunora's identity probe all read the same handler (`*` matches both the
 * Storybook origin and `VITE_LUNORA_URL`).
 */
export type Persona = "free" | "guest" | "pro" | "signed-out";

const CREATED_AT = "2026-01-15T09:00:00.000Z";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

const NAMES: Record<Exclude<Persona, "signed-out">, string> = { free: "Sam Rivera", guest: "Guest", pro: "Ada Lovelace" };

const user = (persona: Exclude<Persona, "signed-out">) => {
    const isAnonymous = persona === "guest";

    return {
        createdAt: CREATED_AT,
        email: isAnonymous ? "guest-7f3a@anonymous.neore.test" : `${persona}@neore.test`,
        emailVerified: !isAnonymous,
        id: `user_${persona}`,
        image: null,
        isAnonymous,
        name: NAMES[persona],
        role: "user",
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
        http.get("*/api/auth/token", () => {
            const session = current();

            return session ? HttpResponse.json({ token: session.session.token }) : HttpResponse.json(null, { status: 401 });
        }),
        // No active organization: the personas are personal accounts.
        http.get("*/api/auth/organization/get-full-organization", () => HttpResponse.json(null)),
    ];
};
