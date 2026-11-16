import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type { OrgSwitcherOrganization, OrgSwitcherUser } from "./org-switcher";
import OrgSwitcher from "./org-switcher";

const USER: OrgSwitcherUser = { email: "ada@example.com", name: "Ada Lovelace" };

const ORGANIZATIONS: OrgSwitcherOrganization[] = [
    { id: "org-analytical", name: "Analytical Engines", slug: "analytical-engines" },
    { id: "org-difference", name: "Difference Labs", slug: "difference-labs" },
];

const meta = {
    args: {
        activeOrgId: null,
        currentUser: USER,
        onCreateOrg: fn(),
        onOpenSettings: fn(),
        onSwitch: fn(),
        organizations: ORGANIZATIONS,
    },
    argTypes: { size: { control: "select", options: ["default", "sm", "icon"] } },
    component: OrgSwitcher,
    decorators: [
        (Story) => (
            <div className="h-72 w-60">
                <Story />
            </div>
        ),
    ],
    title: "Chat/OrgSwitcher",
} satisfies Meta<typeof OrgSwitcher>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The trigger names the active workspace. */
export const Closed: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: /^Switch workspace: currently Ada Lovelace/u })).toBeVisible();
    },
};

export const Open: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: /Switch workspace/u }));

        const menu = within(document.body);

        await waitFor(() => expect(menu.getByRole("menuitem", { name: /Analytical Engines/u })).toBeVisible());
        await expect(menu.getByRole("menuitem", { name: /Create organization/u })).toBeVisible();
        await userEvent.click(menu.getByRole("menuitem", { name: /Difference Labs/u }));
        await expect(args.onSwitch).toHaveBeenCalledWith("org-difference");
        await waitFor(() => expect(menu.queryByRole("menu")).toBeNull());
    },
};

/** With an organization active, the personal account joins the list. */
export const OrganizationActive: Story = {
    args: { activeOrgId: "org-analytical" },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: /^Switch workspace: currently .*Analytical Engines/u }));

        const menu = within(document.body);

        await waitFor(() => expect(menu.getByRole("menuitem", { name: /Personal/u })).toBeVisible());
        await expect(menu.queryByRole("menuitem", { name: /Analytical Engines/u })).toBeNull();
    },
};

export const HidePersonal: Story = {
    args: { activeOrgId: "org-analytical", hidePersonal: true },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: /Switch workspace/u }));

        const menu = within(document.body);

        await waitFor(() => expect(menu.getByRole("menuitem", { name: /Difference Labs/u })).toBeVisible());
        await expect(menu.queryByRole("menuitem", { name: /Personal/u })).toBeNull();
    },
};

export const NoOrganizations: Story = {
    args: { onCreateOrg: undefined, organizations: [] },
};

export const Pending: Story = {
    args: { isPending: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: /Switch workspace/u })).toBeDisabled();
    },
};

export const Compact: Story = { args: { size: "sm" } };

export const IconOnly: Story = { args: { size: "icon" } };
