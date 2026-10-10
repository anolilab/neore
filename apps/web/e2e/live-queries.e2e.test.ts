/**
 * Live queries across tabs: a change made in one tab shows up in another tab
 * of the same user WITHOUT a reload — the subscription pushes it. Before live
 * queries, crpc reads were one-shot fetches and the other tab stayed stale.
 */
import type { Page } from "@playwright/test";

import {
    clickUntilVisible,
    dismissOverlays,
    expect,
    expectAssistantReply,
    openChat,
    REPLY_TIMEOUT,
    sendMessage,
    settle,
    test,
    trackBackendRequests,
} from "./chat-helpers";

/** A sidebar thread row. Rows are `role="button"` divs that navigate on click, not links. */
const THREAD_ROW = "[data-thread-id]";

/** A second tab for the same signed-in user (same context, so same cookies). */
const openSecondTab = async (page: Page): Promise<{ drain: () => Promise<void>; tab: Page }> => {
    const tab = await page.context().newPage();
    const drain = trackBackendRequests(tab);

    await dismissOverlays(tab);

    return { drain, tab };
};

/** No navigation happened in `tab` since it loaded — the update was pushed, not reloaded. */
const navigationCount = async (tab: Page): Promise<number> => await tab.evaluate(() => performance.getEntriesByType("navigation").length);

test.describe("Live queries across tabs", () => {
    test("a task created in one tab appears in the other without a reload", async ({ userPage: page }) => {
        const { drain, tab } = await openSecondTab(page);

        try {
            await settle(page);
            await page.goto("/tasks");
            await tab.goto("/tasks");

            const newTask = page.getByRole("button", { name: "New task" }).first();

            await expect(tab.getByRole("button", { name: "New task" }).first()).toBeVisible({ timeout: 60_000 });

            const navigations = await navigationCount(tab);
            const title = `Live task ${Math.random().toString(36).slice(2, 7)}`;
            const dialog = page.getByRole("dialog", { name: "New task" });

            await clickUntilVisible(newTask, dialog);
            await dialog.getByLabel("Title", { exact: true }).fill(title);
            await dialog.getByPlaceholder("What should the agent do?").fill("Say hello.");
            await dialog.getByRole("button", { name: "Create task" }).click();

            await expect(tab.getByRole("article", { name: title })).toBeVisible({ timeout: 30_000 });
            expect(await navigationCount(tab)).toBe(navigations);
        } finally {
            await drain();
            await tab.close();
        }
    });

    test("a message sent in one tab adds the thread to the other tab's list", async ({ userPage: page }) => {
        const { drain, tab } = await openSecondTab(page);

        try {
            await openChat(page);
            await openChat(tab);

            const before = await tab.locator(THREAD_ROW).count();
            const navigations = await navigationCount(tab);

            await sendMessage(page, "Live list check");
            await expectAssistantReply(page, "Mock reply: Live list check");

            await expect.poll(async () => await tab.locator(THREAD_ROW).count(), { timeout: REPLY_TIMEOUT }).toBeGreaterThan(before);
            expect(await navigationCount(tab)).toBe(navigations);
        } finally {
            await drain();
            await tab.close();
        }
    });
});
