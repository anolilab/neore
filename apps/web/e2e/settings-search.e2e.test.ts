/**
 * The settings modal's search, signed in: typing a setting's name opens its tab, scrolls to the row and rings it,
 * and the search leaves no URL parameter behind once the modal closes. One account walks three tabs from different
 * navigation groups (App, Chat, Chat), so the lazy-loaded chunk of each is awaited by the jump.
 */
import type { Page } from "@playwright/test";

import { expect, settle, test } from "./chat-helpers";

const RESULT_COUNT_RE = /^\d+ results?$/;
const SETTINGS_URL_RE = /[?&](?:settings|settingsTab|q|search)=/;

/** Tab, the setting's row label as the tab shows it, and the result to pick. */
const SETTINGS = [
    { row: "Text Direction", tab: "Customization" },
    { row: "Backup model", tab: "Default Models" },
    { row: "Task Planning Module", tab: "Agent" },
] as const;

const openSettings = async (page: Page): Promise<void> => {
    await settle(page);
    await page.goto("/chat?settings=true");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: 60_000 });
};

test.describe("Settings search", () => {
    test("opens a setting's tab, scrolls to its row and leaves no URL parameter behind", async ({ userPage: page }) => {
        await openSettings(page);

        const dialog = page.getByRole("dialog", { name: "Settings" });
        const field = dialog.getByRole("searchbox", { name: "Search settings" });
        const status = dialog.getByRole("status");

        for (const { row, tab } of SETTINGS) {
            await field.fill(row);
            // The live region announces the count a screen reader hears.
            await expect(status).toHaveText(RESULT_COUNT_RE);

            await dialog.getByRole("navigation", { name: "Settings search results" }).getByRole("button", { name: row }).first().click();

            await expect(dialog.getByRole("heading", { name: tab, level: 2 })).toBeVisible();

            // The row exists once the lazy tab has rendered, and is scrolled into the viewport.
            const target = dialog.getByText(row, { exact: true }).first();

            await expect(target).toBeVisible({ timeout: 30_000 });
            await expect(target).toBeInViewport();
            await expect(field).toHaveValue("");
        }

        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        expect(page.url()).not.toMatch(SETTINGS_URL_RE);
    });
});
