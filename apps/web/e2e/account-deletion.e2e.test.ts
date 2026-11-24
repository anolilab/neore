import { clickUntilVisible, expect, settle, test } from "./chat-helpers";
import { findShardDatabase, queryBackend, shardRowsMentioning } from "./seed";

const SIGN_IN_URL_RE = /\/auth\/sign-in/;

test.describe("Account deletion", () => {
    test("deleting the account signs the user out and removes their rows", async ({ user, userPage: page }) => {
        // Before the identity rows go, the deletion workflow sleeps 2 minutes (`erase-pins-grace`), plus
        // a minute per round of `pin-writes-wait-*` or `usage-exports-live-*` while a pin write or a usage
        // export is in flight (this user has neither). The budget below covers the sign-out wait (60 s),
        // the identity poll (300 s) and the shard poll (120 s); revisit all three if those waits change.
        test.setTimeout(540_000);

        const [row] = await queryBackend<{ id: string }>('SELECT id FROM "user" WHERE email = ?', user.email);

        expect(row?.id, "the seeded user exists before deletion").toBeTruthy();

        const userId = row?.id ?? "";
        // The user's own shard: the deletion
        // workflow must leave nothing of theirs in it.
        const shardFile = await findShardDatabase(userId);

        expect(shardFile, "sign-up seeded the user's own shard").toBeTruthy();

        await settle(page);

        await page.goto("/dashboard/settings/auth/account");
        const dialog = page.getByRole("dialog", { name: "Delete Account" });

        await clickUntilVisible(page.getByRole("button", { name: "Delete Account" }).first(), dialog);

        await expect(dialog.getByText("This permanently deletes your account")).toBeVisible();
        await dialog.getByRole("button", { name: "Delete Account" }).click();

        // Signed out: the sign-out view ends the session and lands on sign-in.
        await expect(page).toHaveURL(SIGN_IN_URL_RE, { timeout: 60_000 });

        // The deletion runs as a workflow, so poll the global (D1) tables until
        // the identity rows are gone, then the user's shard until nothing there
        // names them.
        await expect
            .poll(
                async () => {
                    const [users, sessions, accounts] = await Promise.all([
                        queryBackend('SELECT id FROM "user" WHERE id = ?', userId),
                        queryBackend('SELECT id FROM "session" WHERE "userId" = ?', userId),
                        queryBackend('SELECT id FROM "account" WHERE "userId" = ?', userId),
                    ]);

                    return users.length + sessions.length + accounts.length;
                },
                { intervals: [1000, 2000, 5000], timeout: 300_000 },
            )
            .toBe(0);

        // Only the record that the erasure happened stays, minimised, by design
        // (`minimiseGdprRecords`, Art. 5(2)).
        const KEPT = new Set(["gdprAuditLog", "gdprRequests"]);

        await expect
            .poll(async () => Object.keys(await shardRowsMentioning(shardFile ?? "", userId)).filter((table) => !KEPT.has(table)), {
                intervals: [1000, 2000, 5000],
                timeout: 120_000,
            })
            .toStrictEqual([]);

        // And the account really is gone, not just signed out.
        const response = await page.request.post("/api/auth/sign-in/email", {
            data: { email: user.email, password: user.password },
            headers: { Origin: new URL(page.url()).origin },
        });

        expect(response.ok()).toBe(false);
    });
});
