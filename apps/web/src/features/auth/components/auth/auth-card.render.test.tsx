/**
 * `<AuthCard>` offers sign-up only when registration is open or the visitor
 * holds an invitation (`useInviteOnly().canSignUp`); without one, the sign-up
 * view says that registration is by invitation.
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AuthCard from "./auth-card";

const harness = vi.hoisted(() => {
    return { canSignUp: true, inviteOnly: false as boolean | undefined };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
    };
});

vi.mock("@/features/auth/hooks/use-invite-only", () => {
    return {
        default: () => {
            return { canSignUp: harness.canSignUp, inviteOnly: harness.inviteOnly, mustSignIn: false };
        },
    };
});

vi.mock("@/features/auth/hooks/use-sign-in-methods", () => {
    return {
        default: () => {
            return { findProvider: () => undefined, inviteOnly: harness.inviteOnly, isLoading: false, passkey: false, socialProviders: [] };
        },
    };
});

vi.mock("@/features/auth/hooks/use-last-signin-method", () => {
    return {
        default: () => {
            return { lastSignIn: null };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                basePath: "/auth",
                credentials: {},
                signUp: { fields: ["name"] },
                viewPaths: { SIGN_IN: "sign-in", SIGN_UP: "sign-up" },
            };
        },
    };
});

vi.mock("./auth-form", () => {
    return { default: ({ view }: { view: string }) => <form aria-label={`${view} form`} /> };
});

vi.mock("./last-signin-message", () => {
    return { default: () => null };
});

vi.mock("../organization/accept-invitation-card", () => {
    return { default: () => null };
});

describe("AuthCard sign-up offer", () => {
    beforeEach(() => {
        harness.canSignUp = true;
        harness.inviteOnly = false;
    });

    it("links to sign-up from sign-in when registration is open", () => {
        render(<AuthCard view="SIGN_IN" />);

        expect(screen.getByRole("link", { name: "Sign up" })).toBeTruthy();
    });

    it("offers no sign-up from sign-in under invite-only without an invitation", () => {
        harness.canSignUp = false;
        harness.inviteOnly = true;

        render(<AuthCard view="SIGN_IN" />);

        expect(screen.queryByRole("link", { name: "Sign up" })).toBeNull();
        expect(screen.getByRole("form", { name: "SIGN_IN form" })).toBeTruthy();
    });

    it("offers no sign-up while it is not yet known whether registration is open", () => {
        harness.canSignUp = false;
        harness.inviteOnly = undefined;

        render(<AuthCard view="SIGN_IN" />);

        expect(screen.queryByRole("link", { name: "Sign up" })).toBeNull();
    });

    it("shows the sign-up form to a visitor with an invitation", () => {
        harness.inviteOnly = true;

        render(<AuthCard view="SIGN_UP" />);

        expect(screen.getByRole("form", { name: "SIGN_UP form" })).toBeTruthy();
    });

    it("says registration is by invitation, with a sign-in link, to a visitor without one", () => {
        harness.canSignUp = false;
        harness.inviteOnly = true;

        render(<AuthCard view="SIGN_UP" />);

        expect(screen.getByText("Sign-up needs an invitation")).toBeTruthy();
        expect(screen.queryByRole("form", { name: "SIGN_UP form" })).toBeNull();
        expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
    });
});
