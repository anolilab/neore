import type { Page } from "@playwright/test";

import { composer, expect, test } from "./chat-helpers";

/** `localStorage` key `src/lib/development-msw.ts` reads before it starts the mocked gateway. */
const E2E_MSW_KEY = "neore:e2e-msw";

/** Loads `/chat` with the mocked gateway scenario set before the app starts. */
const openMockedChat = async (page: Page, scenario: string): Promise<void> => {
    await page.addInitScript(
        ({ key, value }: { key: string; value: string }) => {
            globalThis.localStorage.setItem(key, value);
        },
        { key: E2E_MSW_KEY, value: JSON.stringify({ scenario }) },
    );

    await page.goto("/chat");
    await expect(page.locator("html")).toHaveAttribute("data-msw-ready", "true", { timeout: 60_000 });
    await expect(composer(page)).toBeVisible({ timeout: 60_000 });
};

test.describe("Streaming faults from a mocked gateway", () => {
    test("a rate-limited send shows the limit and no reply", async ({ page }: { page: Page }) => {
        await openMockedChat(page, "rate-limited");

        // A refused send keeps the text in the composer for a retry, so this does not
        // wait for the composer to empty (what `sendMessage` checks for).
        await composer(page).fill("hello");
        await page.getByRole("button", { exact: true, name: "Send message" }).click();

        await expect(page.getByText("You've reached the rate limit", { exact: false })).toBeVisible({ timeout: 15_000 });
    });
});
