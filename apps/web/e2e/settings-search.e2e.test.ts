/**
 * The settings modal's search, signed in and without a pointer: typing a setting's name opens its tab, scrolls to
 * the row and rings it, Escape clears the field before it closes the modal, and the search leaves no URL parameter
 * behind. One account walks three tabs from different navigation groups, so the lazy-loaded chunk of each is awaited
 * by the jump.
 */
import type { Page } from "@playwright/test";

import { expect, settle, test } from "./chat-helpers";

const RESULT_COUNT_RE = /^\d+ results?$/;
const SETTINGS_URL_RE = /[?&](?:settings|settingsTab|q|search)=/;

/** Tab, and the setting's row label as the tab shows it. */
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
    test("opens a setting's tab from the keyboard, scrolls to its row and leaves no URL parameter behind", async ({ userPage: page }) => {
        await openSettings(page);

        const dialog = page.getByRole("dialog", { name: "Settings" });
        const field = dialog.getByRole("combobox", { name: "Search settings" });
        const status = dialog.getByRole("status");

        for (const { row, tab } of SETTINGS) {
            await field.focus();
            await page.keyboard.type(row);

            // The live region announces the count a screen reader hears, and the field names the selected result.
            await expect(status).toHaveText(RESULT_COUNT_RE);
            await expect(field).toHaveAttribute("aria-expanded", "true");

            const option = dialog.getByRole("option", { name: row }).first();

            await expect(option).toHaveAttribute("aria-selected", "true");
            await expect(field).toHaveAttribute("aria-activedescendant", (await option.getAttribute("id")) ?? "");

            await page.keyboard.press("Enter");

            await expect(dialog.getByRole("heading", { name: tab, level: 2 })).toBeVisible();

            // The row exists once the lazy tab has rendered, and is scrolled into the viewport.
            const target = dialog.getByText(row, { exact: true }).first();

            await expect(target).toBeVisible({ timeout: 30_000 });
            await expect(target).toBeInViewport();
            await expect(field).toHaveValue("");
            await expect(field).toBeFocused();
        }

        // Escape clears the query first and closes the modal only on the second press.
        await page.keyboard.type("timezone");
        await expect(field).toHaveValue("timezone");
        await page.keyboard.press("Escape");
        await expect(field).toHaveValue("");
        await expect(dialog).toBeVisible();

        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        expect(page.url()).not.toMatch(SETTINGS_URL_RE);
    });
});
