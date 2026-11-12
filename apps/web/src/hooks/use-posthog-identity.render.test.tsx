/**
 * `usePostHogIdentity` publishes a signed-in user as soon as the session knows them, with their organization once it
 * answers, and never an organization without a signed-in user (a cached one after sign-out, a guest's).
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import usePostHogIdentity from "./use-posthog-identity";

const auth = vi.hoisted(() => {
    return {
        organization: { data: undefined as unknown, isPending: true },
        session: { data: undefined as unknown, isPending: true },
    };
});

const setAnalyticsIdentity = vi.hoisted(() => vi.fn());
const setIdentityExpected = vi.hoisted(() => vi.fn());

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return { hooks: { useActiveOrganization: () => auth.organization, useSession: () => auth.session } };
        },
    };
});

vi.mock("@/lib/analytics/posthog-client", () => {
    return { setAnalyticsIdentity, setIdentityExpected };
});

const ACME = { id: "org-1", name: "Acme" };

describe("usePostHogIdentity", () => {
    beforeEach(() => {
        setAnalyticsIdentity.mockClear();
    });

    it("expects an identity while mounted, and lets PostHog start without one once unmounted (a crash in the root)", () => {
        auth.session = { data: undefined, isPending: true };
        auth.organization = { data: undefined, isPending: true };
        setIdentityExpected.mockClear();

        const view = renderHook(() => usePostHogIdentity());

        expect(setIdentityExpected).toHaveBeenLastCalledWith(true);

        view.unmount();

        expect(setIdentityExpected).toHaveBeenLastCalledWith(false);
    });

    it("publishes nothing while the session is pending", () => {
        auth.session = { data: undefined, isPending: true };
        auth.organization = { data: undefined, isPending: true };
        renderHook(() => usePostHogIdentity());

        expect(setAnalyticsIdentity).not.toHaveBeenCalled();
    });

    it("publishes the signed-in user at once, marked organization pending, then the organization when it answers", () => {
        auth.session = { data: { user: { email: "b@example.com", id: "user-2", isAnonymous: false, name: "B" } }, isPending: false };
        auth.organization = { data: undefined, isPending: true };

        const view = renderHook(() => usePostHogIdentity());

        expect(setAnalyticsIdentity).toHaveBeenLastCalledWith({
            isOrganizationPending: true,
            organization: undefined,
            user: { email: "b@example.com", id: "user-2", name: "B" },
        });

        auth.organization = { data: ACME, isPending: false };
        view.rerender();

        expect(setAnalyticsIdentity).toHaveBeenLastCalledWith({
            isOrganizationPending: false,
            organization: ACME,
            user: { email: "b@example.com", id: "user-2", name: "B" },
        });
    });

    it.each([
        ["signed out", null],
        ["a guest", { user: { id: "guest-1", isAnonymous: true } }],
    ])("publishes no organization when %s, even one still cached", (_name, data) => {
        auth.session = { data, isPending: false };
        auth.organization = { data: ACME, isPending: false };
        renderHook(() => usePostHogIdentity());

        expect(setAnalyticsIdentity).toHaveBeenLastCalledWith({ isOrganizationPending: false, organization: undefined, user: undefined });
    });
});
