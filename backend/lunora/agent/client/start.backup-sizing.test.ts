/**
 * A call that may fall back is sized for the backups that could take it, judged on the messages the model is actually
 * handed: an approved call's result can turn into a screenshot, which a backup without vision would be skipped for.
 */
import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FallbackLanguageModel } from "../../chat/lib/fallback-language-model";
import startGeneration from "./start";

const mocks = vi.hoisted(() => {
    return {
        applyLateCompression: vi.fn((messages: ModelMessage[]) => messages),
        fetchContextWithPrompt: vi.fn(),
        saveInputMessages: vi.fn(),
        withApprovedToolModelOutputs: vi.fn(),
    };
});

vi.mock(import("../../chat/lib/auto-continue"), async (importOriginal) => {
    return { ...(await importOriginal()), applyLateCompression: mocks.applyLateCompression };
});

vi.mock(import("./save-input-messages"), () => {
    return { default: mocks.saveInputMessages };
});

vi.mock(import("./search"), async (importOriginal) => {
    return { ...(await importOriginal()), fetchContextWithPrompt: mocks.fetchContextWithPrompt };
});

vi.mock(import("./tool-approval"), async (importOriginal) => {
    return { ...(await importOriginal()), withApprovedToolModelOutputs: mocks.withApprovedToolModelOutputs };
});

const PROMPT = [{ content: "open the page", role: "user" }];
const WITH_SCREENSHOT = [
    ...PROMPT,
    {
        content: [
            {
                output: { type: "content", value: [{ data: "aGk=", mediaType: "image/png", type: "image-data" }] },
                toolCallId: "call-1",
                toolName: "browser",
                type: "tool-result",
            },
        ],
        role: "tool",
    },
];

const model = (modelId: string) => ({ modelId, provider: "test", specificationVersion: "v3" }) as never;

const start = async () =>
    await startGeneration(
        { runMutation: vi.fn(async () => null), runQuery: vi.fn(async () => null), storage: {} } as never,
        {} as never,
        {
            model: new FallbackLanguageModel(model("primary"), [{ model: model("sees-images") }, { model: model("text-only"), supportsImages: false }]),
            promptMessageId: "m1",
        } as never,
        { agentName: "agent", threadId: "thread-1", userId: "user-1" } as never,
    );

beforeEach(() => {
    mocks.applyLateCompression.mockClear();
    mocks.fetchContextWithPrompt.mockResolvedValue({ approvedToolCallIds: ["call-1"], messages: PROMPT, order: 1, stepOrder: 0 });
    mocks.saveInputMessages.mockResolvedValue({
        pendingMessage: { _id: "pending-1", order: 1, stepOrder: 1 },
        promptMessageId: "m1",
        savedMessages: [],
    });
});

describe("startGeneration sizing a call that may fall back", () => {
    it("leaves out a backup that cannot see the screenshot an approved call's result became", async () => {
        expect.assertions(1);

        mocks.withApprovedToolModelOutputs.mockResolvedValue(WITH_SCREENSHOT);

        await start();

        expect(mocks.applyLateCompression).toHaveBeenCalledWith(WITH_SCREENSHOT, "primary", ["sees-images"]);
    });

    it("counts every backup when the messages carry no image", async () => {
        expect.assertions(1);

        mocks.withApprovedToolModelOutputs.mockResolvedValue(PROMPT);

        await start();

        expect(mocks.applyLateCompression).toHaveBeenCalledWith(PROMPT, "primary", ["sees-images", "text-only"]);
    });
});
