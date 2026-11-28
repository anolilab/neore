import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import OnboardingDialog from "@/features/onboarding/components/onboarding-dialog";
import { ONBOARDING_PERSISTENCE_KEY } from "@/features/onboarding/steps";
import { chatFixtures } from "@/storybook/fixtures/chat";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { codeFixtures } from "@/storybook/fixtures/workspace";
import { lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

const WAIT = { timeout: 15_000 } as const;

/** The tour opens for an account that has not finished it; the welcome tour's progress is kept in the browser. */
const handlers = () => {
    return {
        gateway: gatewayModelsHandler(),
        lunora: lunoraHandlers(...userFixtures({ settings: { onboardingCompleted: false } }), ...shellFixtures(), ...chatFixtures(), ...codeFixtures([])),
    };
};

/** The welcome dialog: a first step that offers Chat or Code, the tour that follows Chat, and the coding setup that follows Code. */
const meta = {
    args: { levels: [{ component: OnboardingDialog, path: "/" }], url: "/" },
    beforeEach: () => {
        try {
            localStorage.removeItem(ONBOARDING_PERSISTENCE_KEY);
        } catch {
            // Storage is not available: the dialog starts from its first step anyway.
        }
    },
    component: StoryPage,
    parameters: { layout: "fullscreen", msw: { handlers: handlers() } },
    title: "Pages/Onboarding",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A step slides and fades in; axe reads colours mid-fade, so wait until the step is fully opaque. */
const stepShown = async (name: string) => {
    await waitFor(async () => {
        const heading = await screen.findByRole("heading", { name });

        await expect(heading).toBeVisible();
        await expect(getComputedStyle(heading.parentElement as HTMLElement).opacity).toBe("1");
    }, WAIT);
};

const pairRow = async () => {
    const label = await screen.findByText("Pair a computer");

    return label.closest("li");
};

const firstStep = async () => {
    const dialog = await screen.findByRole("dialog", undefined, WAIT);

    await waitFor(() => expect(dialog).toBeVisible());
    // The dialog title (screen readers only) and the step heading carry the same words.
    await expect(await screen.findAllByRole("heading", { name: "Welcome to Neore" }, WAIT)).toHaveLength(2);

    return dialog;
};

export const FirstStep: Story = {
    play: async () => {
        await firstStep();
        await expect(await screen.findByRole("button", { name: /^Chat/u })).toHaveAttribute("aria-pressed", "true");
        await expect(screen.getByRole("button", { name: /^Code/u })).toHaveAttribute("aria-pressed", "false");
    },
};

export const CodePath: Story = {
    play: async () => {
        await firstStep();
        await userEvent.click(await screen.findByRole("button", { name: /^Code/u }));
        await userEvent.click(screen.getByRole("button", { name: "Next" }));
        await stepShown("Set up coding");
        await waitFor(async () => expect(await pairRow()).toHaveTextContent("To do"), WAIT);
        await expect(screen.getByRole("button", { name: "Open Code" })).toBeVisible();
    },
};

export const ChatPath: Story = {
    play: async () => {
        await firstStep();
        await userEvent.click(await screen.findByRole("button", { name: "Next" }));
        await stepShown("30+ Models, One Thread");
    },
};
