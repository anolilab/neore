import type { Page } from "@playwright/test";

import type { BackendCalls } from "./chat-helpers";
import { composer, expect, recordBackendCalls, settle, test } from "./chat-helpers";

/**
 * Backend executions allowed on first paint of `/chat`.
 *
 * Every one queues on the single `__root__` Durable Object (CLAUDE.md → Local
 * dev), so first paint is only as fast as the queue — and a slow first paint is
 * what browsers abandon mid-flight, which is what used to crash the local
 * backend. First paint needs four (`getThreadListData`, `getUserSettings`,
 * `listProjects`, `getAIUserPreferences`); features had pushed it past fifteen.
 * One spare each. Raising this number is a decision, not a fix: fold the new
 * data into an existing composite query, or load it when its UI opens
 * (`skipToken`) or after first paint (`hooks/use-after-first-paint.ts`).
 */
const FIRST_PAINT_BUDGET = { guest: 5, signedIn: 5 } as const;

const firstPaint = async (page: Page): Promise<BackendCalls> => {
    await settle(page);

    const record = recordBackendCalls(page);

    await page.goto("/chat");
    await expect(composer(page)).toBeVisible({ timeout: 60_000 });
    // Late first-paint fetches count too: wait until a second passes with no
    // new call.
    let seen = -1;

    await expect
        .poll(
            () => {
                const settled = record.calls.length === seen;

                seen = record.calls.length;

                return settled;
            },
            { intervals: [1000], timeout: 30_000 },
        )
        .toBe(true);

    return record;
};

const summarize = (record: BackendCalls): string => `${String(record.calls.length)} calls: ${record.calls.join(", ")}\n401s: ${record.unauthorized.join(", ")}`;

test.describe("First paint of /chat", () => {
    test("a guest stays within the backend-call budget, with no 401s", async ({ page }) => {
        const record = await firstPaint(page);

        await test.info().attach("first-paint-calls", { body: summarize(record) });

        expect(record.unauthorized, summarize(record)).toHaveLength(0);
        expect(record.calls.length, summarize(record)).toBeLessThanOrEqual(FIRST_PAINT_BUDGET.guest);
    });

    test("a signed-in user stays within the backend-call budget, with no 401s", async ({ userPage: page }) => {
        const record = await firstPaint(page);

        await test.info().attach("first-paint-calls", { body: summarize(record) });

        expect(record.unauthorized, summarize(record)).toHaveLength(0);
        expect(record.calls.length, summarize(record)).toBeLessThanOrEqual(FIRST_PAINT_BUDGET.signedIn);
    });
});
