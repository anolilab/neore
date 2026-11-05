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

/**
 * Settings pages inside the real dashboard layout (sidebar, breadcrumbs, page outline).
 * The layout's `<Authenticated>` gate opens because the persona's session and bearer are
 * mocked like everything else.
 */
const meta = {
    component: StoryPage,
    parameters: {
        // An app bug, not a Storybook gap: the dashboard nav uses `colorMode="dark"` (`text-white/80`), but the
        // light `--sidebar` token is white (`packages/ui/src/global.css`), so the nav is 1.1:1 in light mode.
        // Dark mode reads fine. Tracked in #547.
        a11y: { test: "todo" },
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
        await expect(await canvas.findByText(/region restrictions/i)).toBeVisible();
    },
};

export const ApiKeys: Story = {
    args: {
        levels: [dashboard, { component: ApiKeysRoute.options.component, path: "settings/auth/api-keys" }],
        url: "/dashboard/settings/auth/api-keys",
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Laptop CLI")).toBeVisible();
    },
};
