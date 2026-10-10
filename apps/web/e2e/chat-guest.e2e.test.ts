import { expect, expectAssistantReply, openChat, sendMessage, test } from "./chat-helpers";

const COST_LABEL_RE = /^Cost \$/;
const THOUGHT_RE = /Thought for|Thinking/;

test.describe("Guest chat (mock model)", () => {
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
