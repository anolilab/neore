/** `@/lib/auth/server-functions` for Storybook: answers as the active persona instead of reading a cookie on the server. */
import { getActivePersona, sessionFor } from "../../src/storybook/session";

const getSessionToken = async (): Promise<string | null> => sessionFor(getActivePersona())?.session.token ?? null;

export const getSessionAuthState = async (): Promise<{ status: "authenticated" | "unauthenticated"; token: string | null }> => {
    const token = await getSessionToken();

    return { status: token ? "authenticated" : "unauthenticated", token };
};

export default getSessionToken;
