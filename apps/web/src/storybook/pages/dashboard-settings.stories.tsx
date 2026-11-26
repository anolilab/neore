import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, waitFor } from "storybook/test";

import { Route as DashboardRoute } from "@/routes/dashboard/route";
import { Route as AccountRoute } from "@/routes/dashboard/settings/auth/account";
import { Route as ApiKeysRoute } from "@/routes/dashboard/settings/auth/api-keys";
import { Route as SecurityRoute } from "@/routes/dashboard/settings/auth/security";
import { Route as ModelFiltersRoute } from "@/routes/dashboard/settings/chat/model-filters";
import { apiKeyHandlers } from "@/storybook/fixtures/api-keys";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// Page data arrives after the route loads; under a loaded machine that can outlast the 1 s default of `find*`.
const PAGE_WAIT = { timeout: 5000 } as const;

/**
 * Settings pages inside the real dashboard layout (sidebar, breadcrumbs, page outline).
 * The layout's `<Authenticated>` gate opens because the persona's session and bearer are
 * mocked like everything else.
 */
const meta = {
    component: StoryPage,
    parameters: {
        layout: "fullscreen",
        msw: {
            handlers: {
                apiKeys: apiKeyHandlers(),
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures()),
            },
        },
    },
    title: "Pages/Dashboard/Settings",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The linked-account (a password login) and session lists the security and account pages read. */
const authListHandlers = () => [
    http.get("*/api/auth/list-accounts", () =>
        HttpResponse.json([
            {
                accountId: "user-pro",
                createdAt: "2026-10-01T00:00:00.000Z",
                id: "account-credential",
                providerId: "credential",
                scopes: [],
                updatedAt: "2026-10-01T00:00:00.000Z",
                userId: "user-pro",
            },
        ]),
    ),
    http.get("*/api/auth/list-sessions", () => HttpResponse.json([])),
];

const dashboard = { component: DashboardRoute.options.component, path: "/dashboard" } as const;

export const ModelFilters: Story = {
    args: {
        levels: [dashboard, { component: ModelFiltersRoute.options.component, path: "settings/chat/model-filters" }],
        url: "/dashboard/settings/chat/model-filters",
    },
    play: async ({ canvas }) => {
        // The page's words follow the locale toolbar, so the check is on its controls, not on English text.
        await expect(await canvas.findAllByRole("switch", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

export const ApiKeys: Story = {
    args: {
        levels: [dashboard, { component: ApiKeysRoute.options.component, path: "settings/auth/api-keys" }],
        url: "/dashboard/settings/auth/api-keys",
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Laptop CLI", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** Form-bodied cards (change email, change password) with their action footer. */
export const Security: Story = {
    args: {
        levels: [dashboard, { component: SecurityRoute.options.component, path: "settings/auth/security" }],
        url: "/dashboard/settings/auth/security",
    },
    parameters: {
        msw: { handlers: { authLists: authListHandlers() } },
    },
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(canvasElement.querySelector('input[type="password"]')).not.toBeNull(), PAGE_WAIT);
    },
};

/** The account page: profile form cards, and the destructive delete-account card at the bottom. */
export const Account: Story = {
    args: {
        levels: [dashboard, { component: AccountRoute.options.component, path: "settings/auth/account" }],
        url: "/dashboard/settings/auth/account",
    },
    parameters: {
        msw: { handlers: { authLists: authListHandlers() } },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findAllByRole("textbox", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};
