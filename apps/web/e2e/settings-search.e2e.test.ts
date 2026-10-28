/**
 * The settings modal's search, signed in and without a pointer: typing a setting's name opens its tab, scrolls to
 * the row and rings it, Escape clears the field before it closes the modal, and the search leaves no URL parameter
 * behind. One account walks three tabs it has not visited yet, to rows that start below the fold, so the jump has to
 * wait for each lazy-loaded chunk and then scroll; a row that is already on screen would pass without scrolling at all.
 */
import type { Locator, Page } from "@playwright/test";

import { expect, settle, test } from "./chat-helpers";

const RESULT_COUNT_RE = /^\d+ results?$/;
const SETTINGS_URL_RE = /[?&](?:settings|settingsTab|q|search)=/;

const SEARCH_FIELD = "Search settings";

/**
 * Tab, the setting's row label as the tab shows it, and the combobox that holds focus afterwards. All three rows sit
 * below the first screen of a tab that is not open yet. A label names a control (the model picker, which takes focus);
 * a card title does not (focus stays in the search field).
 */
const SETTINGS = [
    { focusName: "Image to video", row: "Image to video", tab: "Default Models" },
    { focusName: SEARCH_FIELD, row: "Onboarding", tab: "Personalization" },
    { focusName: SEARCH_FIELD, row: "Data Export", tab: "Privacy & Data" },
] as const;

const HIGHLIGHT_SELECTOR = ".outline-primary";

/** How far the nearest scrolled ancestor of `locator` is scrolled; 0 when nothing above it has moved. */
const scrollOffsetOf = (locator: Locator): Promise<number> =>
    locator.evaluate((element) => {
        for (let node = element.parentElement; node; node = node.parentElement) {
            if (node.scrollTop > 0) {
                return node.scrollTop;
            }
        }

        return 0;
    });

const openSettings = async (page: Page): Promise<void> => {
    await settle(page);
    await page.goto("/chat?settings=true");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: 60_000 });
};

test.describe("Settings search", () => {
    test("opens a setting's tab from the keyboard, scrolls to its row and leaves no URL parameter behind", async ({ userPage: page }) => {
        await openSettings(page);

        const dialog = page.getByRole("dialog", { name: "Settings" });
        const field = dialog.getByRole("combobox", { name: SEARCH_FIELD });
        const status = dialog.getByRole("status");

        for (const { focusName, row, tab } of SETTINGS) {
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

            // The row exists once the lazy tab has rendered; it is outlined, scrolled into view inside the tab's scroll area.
            const target = dialog.getByText(row, { exact: true }).first();

            await expect(dialog.locator(HIGHLIGHT_SELECTOR).getByText(row, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
            await expect(target).toBeInViewport();
            await expect.poll(() => scrollOffsetOf(target)).toBeGreaterThan(0);

            // A screen reader hears where the pick led, and focus lands on the row's control when it has one.
            await expect(status).toHaveText(`Opened ${tab}: ${row}`);
            await expect(field).toHaveValue("");

            await expect(dialog.getByRole("combobox", { exact: true, name: focusName })).toBeFocused();
        }

        // Escape clears the query first and closes the modal only on the second press.
        await page.keyboard.type("timezone");
        await expect(field).toHaveValue("timezone");
        await page.keyboard.press("Escape");
        await expect(field).toHaveValue("");
        await expect(dialog).toBeVisible();

        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(page).not.toHaveURL(SETTINGS_URL_RE);
    });
});
