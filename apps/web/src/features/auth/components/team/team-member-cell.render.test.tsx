// @vitest-environment jsdom

/** The owner's remove-member control is an X icon, so its accessible name is the only thing a screen reader gets. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { mutateAsync: async () => {} };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return { toast: () => {} };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const mutation = {
        mutationOptions: () => {
            return {};
        },
    };

    return {
        useCRPC: () => {
            return { auth: { team: { removeTeamMember: mutation, updateTeamMemberRole: mutation } } };
        },
    };
});

const { default: TeamMemberCell } = await import("./team-member-cell");

const member = { id: "m1", role: "member" as const, user: { email: "a@example.com", id: "u1", name: "Ada" }, userId: "u1" };

const REMOVE_MEMBER = /^Remove member/;

describe("TeamMemberCell", () => {
    it("names the owner's remove button", () => {
        render(<TeamMemberCell isOwner member={member} teamId="t1" />);

        expect(screen.getByRole("button", { name: "Remove member Ada" })).toBeTruthy();
    });

    it("shows no remove button to non-owners", () => {
        render(<TeamMemberCell member={member} teamId="t1" />);

        expect(screen.queryByRole("button", { name: REMOVE_MEMBER })).toBeNull();
    });
});
