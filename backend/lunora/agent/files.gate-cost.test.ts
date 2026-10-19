/**
 * What `fileGatedByLockedChat` reads, asserted on the code path with a fake
 * `db` that records every table it queries and every page it asks for. The
 * reactive read set of the chat-file readers follows these reads, so the cost
 * is part of the contract: no message read for a user with no locked chat, and
 * no page after the one that holds the file.
 */
import { describe, expect, it, vi } from "vitest";

import { fileGatedByLockedChat } from "./files";

type Page = { continueCursor: string; isDone: boolean; page: { fileIds?: string[] }[] };

const FILE = "file-1" as never;

const fakeContext = (passcodes: { threadId: string }[], pages: Page[], threads: Record<string, { lockedAt?: number }> = {}) => {
    const tables: string[] = [];
    const paginate = vi.fn(async () => pages.shift() ?? { continueCursor: "", isDone: true, page: [] });
    const db = {
        get: async (id: string) => threads[id] ?? null,
        query: (table: string) => {
            tables.push(table);

            const chain = {
                collect: async () => passcodes,
                order: () => chain,
                paginate,
                withIndex: () => chain,
            };

            return chain;
        },
    };

    return { context: { db } as never, paginate, tables };
};

describe(fileGatedByLockedChat, () => {
    it("reads only the passcode index for a user with no locked chat: no message is read (positive)", async () => {
        const { context, paginate, tables } = fakeContext([], []);

        await expect(fileGatedByLockedChat(context, { fileId: FILE, userId: "u" })).resolves.toBe(false);
        expect(tables).toStrictEqual(["threadPasscodes"]);
        expect(paginate).not.toHaveBeenCalled();
    });

    it("stops at the first page that holds the file, without reading the rest (positive)", async () => {
        const { context, paginate } = fakeContext(
            [{ threadId: "locked-1" }],
            [
                { continueCursor: "next", isDone: false, page: [{ fileIds: [FILE] as never }] },
                { continueCursor: "", isDone: true, page: [] },
            ],
            { "locked-1": { lockedAt: 1 } },
        );

        await expect(fileGatedByLockedChat(context, { fileId: FILE, userId: "u" })).resolves.toBe(true);
        expect(paginate).toHaveBeenCalledOnce();
    });

    it("reads every page of a locked chat that does not hold the file (the scan is not bounded, so a file further back is still found)", async () => {
        const { context, paginate } = fakeContext(
            [{ threadId: "locked-1" }],
            [
                { continueCursor: "next", isDone: false, page: [{ fileIds: [] }] },
                { continueCursor: "", isDone: true, page: [{ fileIds: [] }] },
            ],
            { "locked-1": { lockedAt: 1 } },
        );

        await expect(fileGatedByLockedChat(context, { fileId: FILE, userId: "u" })).resolves.toBe(false);
        expect(paginate).toHaveBeenCalledTimes(2);
    });

    it("skips a locked chat whose row is no longer locked, so it reads no message (positive)", async () => {
        const { context, paginate } = fakeContext([{ threadId: "unlocked-1" }], [], { "unlocked-1": {} });

        await expect(fileGatedByLockedChat(context, { fileId: FILE, userId: "u" })).resolves.toBe(false);
        expect(paginate).not.toHaveBeenCalled();
    });
});
