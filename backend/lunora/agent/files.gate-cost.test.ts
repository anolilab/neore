/**
 * What `fileGatedByLockedChat` reads, asserted on the code path with a fake
 * `db` that records every table it queries. The reactive read set of the
 * chat-file readers follows these reads, so the cost is part of the contract:
 * no read for a user with no locked chat, one point lookup per locked chat, and
 * never a message.
 */
import { describe, expect, it } from "vitest";

import { fileGatedByLockedChat } from "./files";

const FILE = "file-1" as never;

/** `holds`: the `chatFileThreads` links that exist, as `threadId`s of `FILE`. */
const fakeContext = (passcodes: { threadId: string }[], holds: string[], threads: Record<string, { lockedAt?: number }> = {}) => {
    const tables: string[] = [];
    let lookup: { table: string; threadId?: string } = { table: "" };
    const db = {
        get: async (id: string) => threads[id] ?? null,
        query: (table: string) => {
            tables.push(table);

            const chain = {
                collect: async () => passcodes,
                first: async () => (table === "chatFileThreads" && holds.includes(lookup.threadId ?? "") ? { _id: "link" } : null),
                withIndex: (_name: string, build: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) => {
                    const fields: Record<string, unknown> = {};
                    const q = {
                        eq(field: string, value: unknown) {
                            fields[field] = value;

                            return q;
                        },
                    };

                    build(q);
                    lookup = { table, threadId: fields.threadId as string | undefined };

                    return chain;
                },
            };

            return chain;
        },
    };

    return { context: { db } as never, tables };
};

describe(fileGatedByLockedChat, () => {
    it("reads only the passcode index for a user with no locked chat (positive)", async () => {
        const { context, tables } = fakeContext([], []);

        await expect(fileGatedByLockedChat(context, { fileId: FILE, userId: "u" })).resolves.toBe(false);
        expect(tables).toStrictEqual(["threadPasscodes"]);
    });

    it("gates a file whose link exists in a locked chat, with one point lookup and no message read (positive)", async () => {
        const { context, tables } = fakeContext([{ threadId: "locked-1" }], ["locked-1"], { "locked-1": { lockedAt: 1 } });

        await expect(fileGatedByLockedChat(context, { fileId: FILE, userId: "u" })).resolves.toBe(true);
        expect(tables).toStrictEqual(["threadPasscodes", "chatFileThreads"]);
    });

    it("does not gate a file that no link places in the locked chat", async () => {
        const { context, tables } = fakeContext([{ threadId: "locked-1" }], [], { "locked-1": { lockedAt: 1 } });

        await expect(fileGatedByLockedChat(context, { fileId: FILE, userId: "u" })).resolves.toBe(false);
        expect(tables).not.toContain("messages");
    });

    it("skips a locked chat whose row is no longer locked, so it looks up no link (positive)", async () => {
        const { context, tables } = fakeContext([{ threadId: "unlocked-1" }], ["unlocked-1"], { "unlocked-1": {} });

        await expect(fileGatedByLockedChat(context, { fileId: FILE, userId: "u" })).resolves.toBe(false);
        expect(tables).not.toContain("chatFileThreads");
    });
});
