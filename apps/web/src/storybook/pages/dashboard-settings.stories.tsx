import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Route as DashboardRoute } from "@/routes/dashboard/route";
import { Route as ApiKeysRoute } from "@/routes/dashboard/settings/auth/api-keys";
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
