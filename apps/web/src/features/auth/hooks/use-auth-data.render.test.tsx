/**
 * `useAuthData` drops its cached entry only once the session is known to be gone: a session still loading, or a subtree
 * hydrating late (`useSession` reads as pending until then), must not clear what other subscribers show.
 */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import authDataCache from "../lib/auth-data-cache";
import useAuthData from "./use-auth-data";

const session = vi.hoisted(() => {
    return { current: { data: undefined as unknown, isPending: true } };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings.join("") };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return { authClient: { useSession: () => session.current }, toast: vi.fn() };
        },
    };
});

const KEY = "accounts";

const Reader = () => {
    useAuthData({
        cacheKey: KEY,
        queryFn: async () => {
            return { data: ["fetched"] };
        },
    });

    return null;
};

describe("useAuthData", () => {
    afterEach(() => {
        authDataCache.clear(KEY);
    });

    it("keeps the cached entry while the session is pending, and drops it once the session is gone", () => {
        authDataCache.set(KEY, ["cached"]);
        session.current = { data: undefined, isPending: true };

        const view = render(<Reader />);

        expect(authDataCache.get(KEY)?.data).toStrictEqual(["cached"]);

        session.current = { data: null, isPending: false };
        view.rerender(<Reader />);

        expect(authDataCache.get(KEY)).toBeUndefined();
    });
});
