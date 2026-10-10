import { assistantMessages, expect, expectAssistantReply, openChat, sendMessage, settle, test, trackBackendRequests } from "./chat-helpers";

const THREAD_URL_RE = /\/chat\/[\w-]+$/;
const PUBLIC_LINK_RE = /\/thread\/[\w-]+$/;

test.describe("In-thread branches (mock model)", () => {
    test("regenerate adds a 2/2 version, switching moves it, and the choice survives a reload", async ({ page }) => {
        await openChat(page);
        await sendMessage(page, "Branch me please");

        const reply = await expectAssistantReply(page, "Mock reply: Branch me please");

        await page.waitForURL(THREAD_URL_RE);

        // The action bar is hover-revealed; the button's name is its sr-only tooltip.
        await reply.hover();
        await reply.getByRole("button", { exact: true, name: "Regenerate" }).click();

        const versions = page.getByRole("group", { name: "Message versions" }).last();

        await expect(versions.getByRole("status")).toHaveText("Version 2 of 2", { timeout: 90_000 });

        await versions.getByRole("button", { name: "Previous version" }).click();
        await expect(versions.getByRole("status")).toHaveText("Version 1 of 2", { timeout: 30_000 });

        // `switchBranch` moved the thread's active leaf on the server, so a fresh
        // load reads the same path back rather than defaulting to the newest.
        await settle(page);
        await page.reload();
        await expect(assistantMessages(page).last()).toContainText("Mock reply: Branch me please", { timeout: 60_000 });
        await expect(page.getByRole("group", { name: "Message versions" }).last().getByRole("status")).toHaveText("Version 1 of 2", {
            timeout: 30_000,
        });
    });
});

test.describe("Public share (mock model)", () => {
    test("a public link opens a redacted read-only view in a fresh browser", async ({ browser, userPage: page }) => {
        // Three browsers in one test: the owner, an anonymous stranger, a signed-in one.
        test.setTimeout(240_000);

        await openChat(page);
        await sendMessage(page, "Share this thread [[reasoning]]");
        await expectAssistantReply(page, "Mock reply: Share this thread");
        await page.waitForURL(THREAD_URL_RE);

        await page.getByRole("button", { name: "Share Thread" }).click();
        await page.getByRole("tab", { name: "Public" }).click();
        await page.getByRole("switch", { name: "Public Access" }).click();

        const link = page.locator(`input[readonly][value*="/thread/"]`);

        await expect(link).toBeVisible({ timeout: 30_000 });

        const url = await link.inputValue();

        expect(url).toMatch(PUBLIC_LINK_RE);

        // A fresh context has no cookies: this is what a stranger with the link sees.
        const stranger = await browser.newContext({ locale: "en-US" });
        const view = await stranger.newPage();
        const drain = trackBackendRequests(view);

        try {
            await view.goto(url);
            await expect(view.getByText("Read-only shared conversation")).toBeVisible({ timeout: 60_000 });
            await expect(view.getByRole("list", { name: "Messages" })).toContainText("Mock reply: Share this thread");

            // Redacted: the reasoning the model produced is not part of the public payload.
            await expect(view.getByText("Mock reasoning")).toHaveCount(0);
        } finally {
            await drain();
            await stranger.close();
        }

        // A SIGNED-IN stranger (a guest) opening the app URL belongs on the share
        // page too. The thread is on its owner's shard, not theirs, so this is the
        // cross-shard `getThreadShareToken` lookup, not the redacted `getThread`.
        const threadPath = new URL(page.url()).pathname;
        const guest = await browser.newContext({ locale: "en-US" });
        const guestPage = await guest.newPage();
        const guestDrain = trackBackendRequests(guestPage);

        try {
            await openChat(guestPage);
            // Let /chat's first paint finish: abandoning it mid-flight is what
            // drops local-dev backend requests (root AGENTS.md, "Local dev").
            await settle(guestPage);
            await guestPage.goto(threadPath);
            await guestPage.waitForURL(`**${new URL(url).pathname}`, { timeout: 60_000 });
            await expect(guestPage.getByText("Read-only shared conversation")).toBeVisible({ timeout: 60_000 });
        } finally {
            await guestDrain();
            await guest.close();
        }
    });
});
