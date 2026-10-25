// @vitest-environment jsdom

/** The team row's overflow trigger is an ellipsis icon; it needs a name. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        Plural: () => null,
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/auth/hooks/organization-management", () => {
    return {
        useActiveOrganization: () => {
            return { data: { members: [{ role: "owner" }] } };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return { authClient: {} };
        },
    };
});

vi.mock("./delete-team-dialog", () => {
    return { default: () => null };
});

vi.mock("./leave-team-dialog", () => {
    return { default: () => null };
});

vi.mock("./team-members-dialog", () => {
    return { default: () => null };
});

const { default: TeamCell } = await import("./team-cell");

describe("TeamCell", () => {
    it("names the actions trigger", () => {
        render(<TeamCell team={{ createdAt: 0, id: "t1", memberCount: 2, name: "Core" }} />);

        expect(screen.getByRole("button", { name: "Team actions" })).toBeTruthy();
    });
});
