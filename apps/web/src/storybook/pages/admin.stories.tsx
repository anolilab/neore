import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Route as AdminAuditLogRoute } from "@/routes/admin/audit-log";
import { Route as AdminCleanupRoute } from "@/routes/admin/cleanup";
import { Route as AdminFeedbackRoute } from "@/routes/admin/feedback";
import { Route as AdminGatewayLayoutRoute } from "@/routes/admin/gateway";
import { Route as AdminGatewayIndexRoute } from "@/routes/admin/gateway/index";
import { Route as AdminIndexRoute } from "@/routes/admin/index";
import { Route as AdminNsfwReviewRoute } from "@/routes/admin/nsfw-review";
import { Route as AdminLayoutRoute } from "@/routes/admin/route";
import { Route as AdminUsersRoute } from "@/routes/admin/users";
import { adminFixtures } from "@/storybook/fixtures/admin";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// The route loads, then its data; with four browser projects running at once that can outlast the 1 s default of `find*`.
const PAGE_WAIT = { timeout: 15_000 } as const;

const LAYOUT = { path: "admin", route: AdminLayoutRoute } as const;

/**
 * The admin area: the real `/admin` layout (its own sidebar nav and breadcrumb) around each page, signed in as the admin
 * persona. The layout's `beforeLoad` admin check is left out by `StoryPage`; the persona is what the sidebar and header read.
 */
const meta = {
    args: { levels: [LAYOUT, { path: "/", route: AdminIndexRoute }], url: "/admin" },
    component: StoryPage,
    parameters: {
        layout: "fullscreen",
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...adminFixtures()) } },
        persona: "admin",
    },
    title: "Pages/Admin",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The dashboard: stat cards, the growth chart, recent sign-ups, the shard footprint and the provider cache readings. */
export const Dashboard: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Recent Registrations", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Users: Story = {
    args: { levels: [LAYOUT, { path: "users", route: AdminUsersRoute }], url: "/admin/users" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Sam Rivera", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const AuditLog: Story = {
    args: { levels: [LAYOUT, { path: "audit-log", route: AdminAuditLogRoute }], url: "/admin/audit-log" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Role Updated", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Gateway: Story = {
    args: {
        levels: [LAYOUT, { path: "gateway", route: AdminGatewayLayoutRoute }, { path: "/", route: AdminGatewayIndexRoute }],
        url: "/admin/gateway",
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Model Breakdown", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Feedback: Story = {
    args: { levels: [LAYOUT, { path: "feedback", route: AdminFeedbackRoute }], url: "/admin/feedback" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/model picker closes/i, undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const NsfwReview: Story = {
    args: { levels: [LAYOUT, { path: "nsfw-review", route: AdminNsfwReviewRoute }], url: "/admin/nsfw-review" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("NSFW Content Review", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Cleanup: Story = {
    args: { levels: [LAYOUT, { path: "cleanup", route: AdminCleanupRoute }], url: "/admin/cleanup" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Run History", undefined, PAGE_WAIT)).toBeVisible();
    },
};
