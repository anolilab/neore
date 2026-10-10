/**
 * The background agent (`chat/execute.ts`) reads a thread's settings through
 * `getThreadSettings` with NO user identity — it runs as a scheduled action.
 *
 * That lookup used to go through the public `agent_threads.getThread`, which
 * answers an identity-less caller `null` for every private thread: the agent
 * silently ran without the thread's system prompt, language or features. It now
 * reads through `getThreadInternal`, which returns the full row.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";

import { getThread, getThreadInternal } from "../agent/threads";
import schema from "../schema";
import { getThreadSettings } from "./functions";

/** The harness's `runQuery` takes registered procedures, not `{ __lunoraRef }`s. */
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const settingsWithoutIdentity = async (lookup: unknown) => {
    registry.set("agent_threads:getThreadInternal", lookup);

    const harness = lunoraTest(schema as never);

    try {
        const threadId = await harness.run(
            async (context: any) =>
                await context.db.insert("threads", { customSystemPrompt: "Answer in haiku.", language: "de", status: "active", userId: "owner" }),
        );

        return await harness.query(async (context: any) => await context.runQuery(getThreadSettings, { threadId }));
    } finally {
        harness.close();
    }
};

describe("getThreadSettings with no user identity", () => {
    it("returns the private thread's full settings through the internal lookup", async () => {
        await expect(settingsWithoutIdentity(getThreadInternal)).resolves.toMatchObject({ customSystemPrompt: "Answer in haiku.", language: "de" });
    });

    it("control: the public lookup yields nothing for the same caller", async () => {
        await expect(settingsWithoutIdentity(getThread)).resolves.toBeNull();
    });
});
