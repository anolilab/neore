/**
 * The GDPR export must contain EVERY message of every thread the user owns.
 *
 * It runs inside a workflow with no user identity. It used to read through the
 * public `listThreadsByUserId` / `listMessagesByThreadId`, which answer an
 * identity-less caller with an empty page — so exports shipped with no
 * conversations at all, and nothing noticed.
 *
 * 36 messages across three threads, deliberately past 25: a 12-row fixture
 * cannot tell a complete read from one capped at a default page size.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";

import { listMessagesByThreadIdInternal } from "../agent/messages";
import { listThreadsByUserIdInternal } from "../agent/threads";
import schema from "../schema";
import { collectConversations, collectThreadTags } from "./steps";

/**
 * The harness's `ctx.runQuery` takes the REGISTERED procedure object, not a
 * generated `{ __lunoraRef }`. Route `internal.<module>.<fn>` to the real
 * procedures so the step under test runs unmodified.
 */
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const THREADS = 3;
const MESSAGES_PER_THREAD = 12;

describe("collectConversations", () => {
    it("exports all messages of all the user's threads, and nobody else's", async () => {
        registry.set("agent_messages:listMessagesByThreadIdInternal", listMessagesByThreadIdInternal);
        registry.set("agent_threads:listThreadsByUserIdInternal", listThreadsByUserIdInternal);
        registry.set("gdpr_steps:collectThreadTags", collectThreadTags);

        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                for (let t = 0; t < THREADS; t += 1) {
                    const threadId = await context.db.insert("threads", { status: "active", title: `Thread ${String(t)}`, userId: "user-1" });

                    for (let m = 0; m < MESSAGES_PER_THREAD; m += 1) {
                        await context.db.insert("messages", {
                            order: m,
                            status: "success",
                            stepOrder: 0,
                            text: `t${String(t)}-m${String(m)}`,
                            threadId,
                            tool: false,
                            userId: "user-1",
                        });
                    }
                }

                const otherThread = await context.db.insert("threads", { status: "active", title: "Not mine", userId: "user-2" });

                await context.db.insert("messages", {
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    text: "someone else",
                    threadId: otherThread,
                    tool: false,
                    userId: "user-2",
                });
            });

            // Internal functions are unreachable from the harness's external
            // boundary, as in production — dispatch it the way the workflow does.
            const conversations = await harness.action(async (context: any) => await context.runAction(collectConversations, { userId: "user-1" }));
            const exported = conversations as { messages: { text?: string }[]; thread: { title?: string } }[];

            expect(exported).toHaveLength(THREADS);
            expect(exported.flatMap((conversation) => conversation.messages)).toHaveLength(THREADS * MESSAGES_PER_THREAD);
            expect(exported.map((conversation) => conversation.thread.title)).not.toContain("Not mine");

            for (const conversation of exported) {
                // Ascending, complete, in order.
                expect(conversation.messages.map((message) => message.text?.split("-", 2)[1])).toEqual(
                    Array.from({ length: MESSAGES_PER_THREAD }, (_unused, index) => `m${String(index)}`),
                );
            }
        } finally {
            harness.close();
        }
    });
});
