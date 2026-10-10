/**
 * Signed-in agent flows against the mock model: tool approval, group chat,
 * tasks and a script-driven HTML artifact. Each test gets its own invited
 * account (the `user` fixture), so settings one test changes never leak.
 */
import type { Locator, Page } from "@playwright/test";

import { clickUntilVisible, expect, expectAssistantReply, openChat, REPLY_TIMEOUT, sendMessage, settle, test } from "./chat-helpers";

const THREAD_URL_RE = /\/chat\/[\w-]+$/;
const CREATE_SKILL_RE = /^(?:Add Skill|Create Skill)$/i;
const DONE_COLUMN_RE = /^Done \d+$/;

/** Fills `field` again until it holds `value`: a fill React renders over is retried, not lost. */
const fillUntilSet = async (field: Locator, value: string): Promise<void> => {
    await expect(async () => {
        await field.fill(value);
        await expect(field).toHaveValue(value, { timeout: 1000 });
    }).toPass({ timeout: 30_000 });
};

/** Create a skill through the /skills dialog; new skills are enabled on creation. */
const createSkill = async (page: Page, name: string, command: string): Promise<void> => {
    await settle(page);
    await page.goto("/skills");

    const create = page.getByRole("button", { name: CREATE_SKILL_RE }).first();

    const dialog = page.getByRole("dialog", { name: "Create skill" });

    await clickUntilVisible(create, dialog);

    // Filled field by field until each value sticks. The dialog's controlled
    // inputs can take a fill in the same frame as the body mounting (or as the
    // name's derived-command write), and a value React then renders over is
    // lost silently: the form stays invalid and "Create skill" disabled, which
    // once surfaced only as a 120s click timeout.
    await fillUntilSet(dialog.getByPlaceholder("e.g. Code reviewer"), name);
    await fillUntilSet(dialog.getByPlaceholder("code-reviewer"), command);
    await fillUntilSet(dialog.getByPlaceholder("When should the assistant use this skill?"), `${name} answers group-chat questions.`);
    await fillUntilSet(dialog.getByPlaceholder("Tell the assistant exactly what to do.", { exact: false }), `You are ${name}. Answer briefly.`);

    const submit = dialog.getByRole("button", { name: "Create skill" });

    // A still-invalid form fails here in seconds, naming its validation errors,
    // instead of in the click's own long timeout.
    await expect(async () => {
        const errors = await dialog.locator("[data-slot=form-message]").allInnerTexts();

        await expect(submit, `skill form still invalid: ${errors.join("; ")}`).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await submit.click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
};

test.describe("Tool approval (mock model)", () => {
    test("a tool set to Ask pauses for approval, and approving continues the run", async ({ userPage: page }) => {
        // A tool the default Chat mode offers (`SEARCH_MODE_TOOLS.chat` in the
        // backend's tool-builder) that needs no provider key. `dateTime` is one
        // too, but `createDocument` writes a row, so approving it proves more
        // than a clock read would.
        const tool = "createDocument";
        const input = JSON.stringify({ content: "Approved content", kind: "text", title: `E2E approval ${Math.random().toString(36).slice(2, 7)}` });

        await settle(page);
        await page.goto("/chat?settings=true&settingsTab=chat-tools");

        const ask = page.getByRole("button", { name: `Ask for ${tool}` });

        await expect(ask).toBeVisible({ timeout: 60_000 });
        // Click until it sticks: the row can paint before its handler is live,
        // and a click in that window never reaches `setToolPermission`. A second
        // click on an already-pressed "Ask" is a no-op, so retrying is safe.
        await expect(async () => {
            if ((await ask.getAttribute("aria-pressed")) !== "true") {
                await ask.click();
            }

            await expect(ask).toHaveAttribute("aria-pressed", "true", { timeout: 5000 });
        }).toPass({ timeout: 60_000 });
        await page.keyboard.press("Escape");

        await openChat(page);
        await sendMessage(page, `Write it down [[tool:${tool} ${input}]]`);

        const approval = page
            .getByRole("group")
            .filter({ hasText: `Allow "${tool}"?` })
            .last();

        await expect(approval).toBeVisible({ timeout: REPLY_TIMEOUT });
        await approval.getByRole("button", { name: `Approve ${tool} once` }).click();

        // The mock answers the post-tool step with this line, so seeing it means
        // the tool ran and the agent loop resumed after the approval.
        await expectAssistantReply(page, `Mock: tool ${tool} finished`);
    });
});

test.describe("Group chat (mock model)", () => {
    test("two skills taking turns answer under their own speaker labels", async ({ userPage: page }) => {
        const suffix = Math.random().toString(36).slice(2, 7);
        const first = `Alpha ${suffix}`;
        const second = `Beta ${suffix}`;

        await createSkill(page, first, `alpha-${suffix}`);
        await createSkill(page, second, `beta-${suffix}`);

        await openChat(page);

        const dialog = page.getByRole("dialog", { name: "New group chat" });

        await clickUntilVisible(page.getByRole("button", { name: "New group chat" }).first(), dialog);

        await dialog.getByRole("checkbox", { name: new RegExp(first) }).click();
        await dialog.getByRole("checkbox", { name: new RegExp(second) }).click();
        // Round robin: one speaker per turn, alternating — no router call to depend on.
        await dialog.getByText("Take turns", { exact: true }).click();
        await dialog.getByRole("button", { name: "Create group chat" }).click();
        await page.waitForURL(THREAD_URL_RE, { timeout: 30_000 });

        await sendMessage(page, "First round");
        await expectAssistantReply(page, "Mock reply: First round");
        await sendMessage(page, "Second round");
        await expectAssistantReply(page, "Mock reply: Second round");

        const replies = page.locator('.message-item[data-message-role="assistant"]');

        await expect(replies.filter({ hasText: first }).first()).toBeVisible();
        await expect(replies.filter({ hasText: second }).first()).toBeVisible();
    });
});

test.describe("Tasks (mock model)", () => {
    test("a task runs on the mock, passes the verifier and lands in Done", async ({ userPage: page }) => {
        const title = `E2E task ${Math.random().toString(36).slice(2, 7)}`;

        await settle(page);

        await page.goto("/tasks");
        const dialog = page.getByRole("dialog", { name: "New task" });

        await clickUntilVisible(page.getByRole("button", { name: "New task" }).first(), dialog);

        // By placeholder: "Instructions" is also a substring of other labels.
        const instructions = dialog.getByPlaceholder("What should the agent do?");

        await dialog.getByLabel("Title", { exact: true }).fill(title);
        await instructions.fill("Say hello.");
        await expect(instructions).toHaveValue("Say hello.");
        await dialog.getByPlaceholder("e.g. Lists at least five sources", { exact: false }).fill("The answer says hello.");
        await dialog.getByRole("button", { name: "Create task" }).click();
        await expect(dialog).toBeHidden({ timeout: 30_000 });

        const card = page.getByRole("article", { name: title });

        await card.getByRole("button", { name: "Run" }).click();

        // The verifier asks for `{"pass": boolean, ...}`; the mock answers that
        // template with `pass: true`, so the round is accepted, not reviewed.
        // The board shows status by column, not on the card (`showStatus` is list-view only).
        const done = page.getByRole("region", { name: DONE_COLUMN_RE }).getByRole("article", { name: title });

        await expect(done).toBeVisible({ timeout: REPLY_TIMEOUT });
        await expect(done.getByRole("button", { name: "Run again" })).toBeVisible();
    });
});

test.describe("HTML artifact (mock model)", () => {
    test("the preview runs a script-driven HTML document", async ({ userPage: page }) => {
        const title = `E2E Script Artifact ${Math.random().toString(36).slice(2, 7)}`;
        // Short on purpose: a long paste turns into an attachment in the composer.
        const html = "<p id=out>waiting</p><script>out.textContent='script ran'</script>";
        const input = JSON.stringify({ content: html, kind: "code", language: "html", title });

        await openChat(page);
        await sendMessage(page, `Build it [[tool:createDocument ${input}]]`);

        const card = page.getByRole("button", { name: new RegExp(title) }).first();

        await expect(card).toBeVisible({ timeout: REPLY_TIMEOUT });
        await card.click();

        const codeView = page.getByRole("group", { name: "Code view" });

        await codeView.getByRole("button", { name: "Preview" }).click();

        const frame = page.frameLocator(`iframe[title="Preview of ${title}"]:not([aria-hidden="true"])`);

        await expect(frame.locator("#out")).toHaveText("script ran", { timeout: 30_000 });
    });
});
