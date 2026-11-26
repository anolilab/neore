// @vitest-environment jsdom

/** The header holds the organization and team switchers only; everything else moved to the dock. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => {
    return { activeOrganization: undefined as { id: string } | undefined, organizations: [] as { id: string }[] };
});

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return {
        useAuthActiveOrganization: () => {
            return { data: session.activeOrganization };
        },
        useAuthOrganizationList: () => {
            return { data: session.organizations };
        },
    };
});

vi.mock("@/features/auth/components/organization/organization-switcher", () => {
    return { default: () => <button type="button">Organization switcher</button> };
});

vi.mock("@/features/auth/components/team/team-switcher", () => {
    return { default: () => <button type="button">Team switcher</button> };
});

const { default: ThreadListHeader } = await import("./thread-list-header");

describe("ThreadListHeader", () => {
    it("renders nothing for someone with no organization", () => {
        session.activeOrganization = undefined;
        session.organizations = [];
        const { container } = render(<ThreadListHeader />);

        // eslint-disable-next-line testing-library/no-node-access -- an empty header must leave no markup behind
        expect(container.firstChild).toBeNull();
    });

    it("shows the team switcher inside an organization, and the organization switcher once there are several", () => {
        session.activeOrganization = { id: "o1" };
        session.organizations = [{ id: "o1" }];
        const { unmount } = render(<ThreadListHeader />);

        expect(screen.getByRole("button", { name: "Team switcher" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Organization switcher" })).toBeNull();
        unmount();

        session.organizations = [{ id: "o1" }, { id: "o2" }];
        render(<ThreadListHeader />);

        expect(screen.getByRole("button", { name: "Organization switcher" })).toBeTruthy();
    });

    it("holds none of the thread controls the dock owns", () => {
        session.activeOrganization = { id: "o1" };
        session.organizations = [{ id: "o1" }];
        render(<ThreadListHeader />);

        for (const name of ["Search threads", "Add project", "New Thread", "Search filters"]) {
            expect(screen.queryByRole("button", { name })).toBeNull();
        }
    });
});
