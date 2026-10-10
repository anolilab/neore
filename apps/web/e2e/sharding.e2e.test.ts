/**
 * Per-user sharding (docs/plans/per-user-sharding.md), end to end: a guest's
 * rows follow them into the account they convert to, and a caller cannot
 * address a shard that is not theirs.
 */
import {
    assistantMessages,
    completeOnboarding,
    contextPoster,
    expect,
    expectAssistantReply,
    freshUser,
    openChat,
    sendMessage,
    settle,
    test,
} from "./chat-helpers";
import { APP_BASE_URL, LUNORA_URL } from "./fixtures";
import { signUpInvited } from "./seed";

const THREAD_URL_RE = /\/chat\/[\w-]+$/;

test.describe("Per-user shards", () => {
    test("a guest who converts keeps the thread they started as a guest", async ({ page }) => {
        await openChat(page);
        await sendMessage(page, "Keep me after sign-up");
        await expectAssistantReply(page, "Mock reply: Keep me after sign-up");
        await page.waitForURL(THREAD_URL_RE);

        const threadUrl = page.url();

        // Signing up from the guest session converts it: a NEW user, and the
        // guest's rows move from the guest's shard to theirs.
        await settle(page);
        await signUpInvited(freshUser("convert"), contextPoster(page));
        await completeOnboarding(page);

        // The move is a queue job, so the thread lands on the new shard shortly
        // after sign-up: reload until it is there.
        await expect(async () => {
            await page.goto(threadUrl);
            await expect(assistantMessages(page).filter({ hasText: "Mock reply: Keep me after sign-up" }).last()).toBeVisible({ timeout: 15_000 });
        }).toPass({ timeout: 120_000 });
    });

    test("a caller may address their own shard and no one else's", async ({ userPage: page }) => {
        await settle(page);

        const tokenReply = await page.request.get("/api/auth/token");
        const { token } = (await tokenReply.json()) as { token?: string };

        expect(token, "the signed-in page gets an RPC token").toBeTruthy();

        const rpc = async (shardKey?: string) =>
            await page.request.post(`${LUNORA_URL}/_lunora/rpc`, {
                data: { args: {}, functionPath: "auth_functions:getUserSettings", ...(shardKey && { shardKey }) },
                // The app's origin, as the browser client sends it (the CSRF check).
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: new URL(APP_BASE_URL).origin },
            });

        // No shard named: the backend sends it to the caller's own.
        const own = await rpc();

        expect(own.status(), await own.text()).toBe(200);

        // A forged shard key — someone else's shard, no grant — is refused before
        // any procedure runs.
        const forged = await rpc("someone-else-entirely");

        expect(forged.status()).toBe(403);
        expect(await forged.text()).toContain("FORBIDDEN_SHARD");
    });
});
