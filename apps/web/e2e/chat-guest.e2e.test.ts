import { composer, expect, expectAssistantReply, freshUser, isInviteOnly, openChat, recordBackendCalls, sendMessage, test, userMessages } from "./chat-helpers";
import { signUpInvited } from "./seed";

const COST_LABEL_RE = /^Cost \$/;
const THOUGHT_RE = /Thought for|Thinking/;

/**
 * Registration is invite-only in this suite (`SIGNUP_INVITE_ONLY` unset), so a
 * visitor is never a guest: `/chat` renders signed out and sending asks them to
 * sign in, then sends the message by itself. With registration open the old
 * guest chat applies instead (`a guest's message gets a reply`).
 */
test.describe("Signed-out chat under invite-only (mock model)", () => {
    test.beforeEach(async () => {
        // Conditional, not a disabled test: a backend with registration open has guests instead.
        test.skip(!(await isInviteOnly()), "registration is open on this backend");
    });

    test("sending asks for a sign-in, keeps the draft, and sends the message once after it", async ({ page }) => {
        // Registered elsewhere: this browser stays signed out until the prompt.
        const user = freshUser("signed-out-send");

        await signUpInvited(user);

        const calls = recordBackendCalls(page);

        await openChat(page);

        // No guest was made, and no sign-up is offered.
        expect(calls.unauthorized).toHaveLength(0);
        expect((await page.context().cookies()).some((cookie) => cookie.name.endsWith("session_token"))).toBe(false);
        await expect(page.locator('a[href*="/auth/sign-up"]')).toHaveCount(0);

        await composer(page).click();
        await composer(page).fill("Hello after signing in");
        await page.getByRole("button", { exact: true, name: "Send message" }).click();

        const prompt = page.getByRole("dialog");

        await expect(prompt.getByText("Welcome back")).toBeVisible();
        await expect(prompt.getByRole("link", { name: "Sign up" })).toHaveCount(0);

        // Dismissing keeps the draft.
        await page.keyboard.press("Escape");
        await expect(prompt).toHaveCount(0);
        await expect(composer(page)).toHaveText("Hello after signing in");

        await page.getByRole("button", { exact: true, name: "Send message" }).click();
        await prompt.getByPlaceholder("Enter your email").fill(user.email);
        await prompt.getByPlaceholder("Enter your password").fill(user.password);
        await prompt.getByRole("button", { exact: true, name: "Sign in" }).click();

        await expectAssistantReply(page, "Mock reply: Hello after signing in");
        await expect(userMessages(page).filter({ hasText: "Hello after signing in" })).toHaveCount(1);

        // Sent once: a reload shows one message, not a second send.
        await page.reload();
        await expectAssistantReply(page, "Mock reply: Hello after signing in");
        await expect(userMessages(page).filter({ hasText: "Hello after signing in" })).toHaveCount(1);
    });
});

test.describe("Guest chat when registration is open (mock model)", () => {
    test.beforeEach(async () => {
        // Conditional, not a disabled test: under invite-only there are no guests.
        test.skip(await isInviteOnly(), "registration is invite-only on this backend, so there are no guests");
    });

    test("a guest's message gets a reply, a reasoning panel and a cost badge", async ({ page }) => {
        await openChat(page);
        await sendMessage(page, "Hello from the guest spec [[reasoning]]");

        // The mock echoes the prompt minus its markers, so this text can only
        // come from a round trip through the gateway.
        const reply = await expectAssistantReply(page, "Mock reply: Hello from the guest spec");

        // Reasoning: the mock emitted a reasoning part, which renders as the
        // collapsible "Thought for …" panel above the answer.
        await expect(reply.getByText(THOUGHT_RE).first()).toBeVisible();

        // Cost: the gateway priced the call and the backend folded it into the
        // message, so the stats bar shows a badge named "Cost $…".
        await expect(reply.getByRole("button", { name: COST_LABEL_RE })).toBeVisible({ timeout: 30_000 });
    });
});

test.describe("Chat as an account (mock model)", () => {
    test("a signed-in user's message gets a reasoning panel and a cost badge", async ({ userPage: page }) => {
        await openChat(page);
        await sendMessage(page, "Hello from the signed-in spec [[reasoning]]");

        const reply = await expectAssistantReply(page, "Mock reply: Hello from the signed-in spec");

        await expect(reply.getByText(THOUGHT_RE).first()).toBeVisible();
        await expect(reply.getByRole("button", { name: COST_LABEL_RE })).toBeVisible({ timeout: 30_000 });
    });
});
