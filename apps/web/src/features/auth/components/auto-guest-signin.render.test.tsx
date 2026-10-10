/**
 * `<AutoGuestSignIn>` end to end, with the auth client and the RPC client faked:
 * how many guest sign-ins actually go out, and whether a duplicate / failed one
 * still ends with the session's token on the RPC client (the blank `/chat` bug).
 */

import { act, render } from "@testing-library/react";
import { createElement, Fragment, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALREADY_ANONYMOUS_CODE, resetAdoptionBackoff } from "../lib/guest-session";

const harness = vi.hoisted(() => {
    const state = { token: null as string | null, user: undefined as { id: string } | undefined };

    return {
        anonymous: vi.fn(),
        getSession: vi.fn(),
        getSessionToken: vi.fn(),
        navigateOnSuccess: vi.fn(),
        setAuthToken: vi.fn((token: string | null) => {
            state.token = token;
        }),
        state,
        toast: vi.fn(),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    const authClient = { getSession: harness.getSession, signIn: { anonymous: harness.anonymous } };

    return {
        useAuth: () => {
            return { authClient, toast: harness.toast };
        },
    };
});

vi.mock("@/features/auth/hooks/use-anonymous-signin-tracking", () => {
    return {
        default: () => {
            return { trackAnonymousSignIn: vi.fn() };
        },
    };
});

vi.mock("@/features/auth/hooks/use-success-transition", () => {
    return {
        default: ({ stayOnPage }: { stayOnPage?: boolean }) => {
            return {
                onSuccess: async () => {
                    if (!stayOnPage) {
                        harness.navigateOnSuccess();
                    }
                },
            };
        },
    };
});

vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});

vi.mock("@/lib/auth/server-functions", () => {
    return { default: harness.getSessionToken };
});

vi.mock("@/lib/lunora/crpc", () => {
    const lunoraClient = { getAuthToken: () => harness.state.token, setAuthToken: harness.setAuthToken };

    return { useLunora: () => lunoraClient };
});

const { default: AutoGuestSignIn } = await import("./auto-guest-signin");

/** The refusal better-auth sends for a second anonymous sign-in, as better-fetch throws it. */
const alreadyAnonymous = (): Error =>
    Object.assign(new Error("Bad Request"), { error: { code: ALREADY_ANONYMOUS_CODE }, status: 400, statusText: "Bad Request" });

beforeEach(() => {
    vi.useFakeTimers();
    resetAdoptionBackoff();
    harness.state.token = null;
    harness.state.user = undefined;
    harness.getSession.mockImplementation(async () => {
        return { data: harness.state.user ? { user: harness.state.user } : null };
    });
    harness.anonymous.mockImplementation(async () => {
        harness.state.user = { id: "guest" };
    });
    harness.getSessionToken.mockResolvedValue("guest-jwt");
});

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe("<AutoGuestSignIn>", () => {
    it("sends ONE sign-in for a StrictMode double effect plus a second mount", async () => {
        const twoMounts = createElement(Fragment, null, createElement(AutoGuestSignIn), createElement(AutoGuestSignIn));

        render(createElement(StrictMode, null, twoMounts));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(harness.anonymous).toHaveBeenCalledTimes(1);
        expect(harness.toast).not.toHaveBeenCalled();
        // Auto sign-in happens on the page the visitor opened — never a redirect to "/".
        expect(harness.navigateOnSuccess).not.toHaveBeenCalled();
    });

    it("recovers from the 400 'already anonymous' by adopting the session's token", async () => {
        // The remount case: the guest cookie is set, but this tab's session read
        // came back empty, so a second sign-in goes out and is refused.
        harness.anonymous.mockRejectedValueOnce(alreadyAnonymous());

        render(createElement(AutoGuestSignIn));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(harness.anonymous).toHaveBeenCalledTimes(1);
        expect(harness.toast).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });

        expect(harness.setAuthToken).toHaveBeenCalledWith("guest-jwt");
    });

    it("re-probes when the RPC client already holds the session's token", async () => {
        // The identity probe failed with a token set: `<Unauthenticated>` over a
        // valid session, which only a token CHANGE re-probes.
        harness.state.user = { id: "guest" };
        harness.state.token = "guest-jwt";

        render(createElement(AutoGuestSignIn));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });

        expect(harness.anonymous).not.toHaveBeenCalled();
        expect(harness.setAuthToken.mock.calls).toStrictEqual([[null], ["guest-jwt"]]);
    });

    it("keeps retrying a failed sign-in instead of leaving the page empty, and reports it once", async () => {
        harness.anonymous.mockRejectedValueOnce(new Error("network")).mockRejectedValueOnce(new Error("network"));

        render(createElement(AutoGuestSignIn));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(harness.anonymous).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        expect(harness.anonymous).toHaveBeenCalledTimes(2);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(4000);
        });
        expect(harness.anonymous).toHaveBeenCalledTimes(3);
        expect(harness.toast).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });
        expect(harness.setAuthToken).toHaveBeenCalledWith("guest-jwt");
    });

    it("stops everything on unmount", async () => {
        harness.anonymous.mockRejectedValue(new Error("network"));

        const { unmount } = render(createElement(AutoGuestSignIn));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        unmount();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });

        expect(harness.anonymous).toHaveBeenCalledTimes(1);
        expect(harness.setAuthToken).not.toHaveBeenCalled();
    });
});
