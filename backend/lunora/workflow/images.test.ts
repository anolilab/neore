import { describe, expect, it } from "vitest";

import { countedWorkflowFileIds, grantWorkflowFiles, signWorkflowImages, workflowFileIds } from "./images";

const content = (...ids: string[]) => {
    return {
        edges: [],
        nodes: ids.map((id, index) => {
            return { data: { imageFileId: id }, id: `n${index}` };
        }),
    };
};

/** A `db` holding chat files `a`–`d`, with `owner` granted all but `c`, and `d` gone (grant left behind). */
const fakeDb = () => {
    const reads: string[] = [];
    const grants = [
        { fileId: "a", userId: "owner" },
        { fileId: "b", userId: "owner" },
        { fileId: "c", userId: "someone-else" },
        { fileId: "d", userId: "owner" },
    ];
    const files = [
        { _id: "a", storageId: "agent-files/a" },
        { _id: "b", storageId: "agent-files/b" },
        { _id: "c", storageId: "agent-files/c" },
    ];

    const db = {
        chatFileAccess: {
            findMany: async ({ where }: { where: { fileId: { in: string[] }; userId: string } }) => {
                reads.push("chatFileAccess");

                return { page: grants.filter((grant) => where.fileId.in.includes(grant.fileId) && grant.userId === where.userId) };
            },
        },
        chatFiles: {
            findMany: async ({ where }: { where: { _id: { in: string[] } } }) => {
                reads.push("chatFiles");

                return { page: files.filter((file) => where._id.in.includes(file._id)) };
            },
        },
    };

    return { db: db as never, reads };
};

describe("workflowFileIds", () => {
    it("returns each distinct image file id once, ignoring nodes without one", () => {
        expect(workflowFileIds({ nodes: [{ data: { imageFileId: "a" } }, { data: {} }, { data: { imageFileId: "a" } }, {}] })).toStrictEqual(["a"]);
        expect(workflowFileIds(undefined)).toStrictEqual([]);
        expect(workflowFileIds({ nodes: "nope" })).toStrictEqual([]);
    });

    it("includes a file node's reference media, so a saved workflow keeps it from the unused-file sweep", () => {
        expect(workflowFileIds({ nodes: [{ data: { fileId: "v", fileName: "clip.mp4", fileType: "video/mp4" } }, { data: { fileId: "a" } }] })).toStrictEqual([
            "v",
            "a",
        ]);
    });

    it("includes the frames a video node captured, skipping unset ones", () => {
        const captured = {
            nodes: [
                { data: { frameFileIds: { end: "e", picked: undefined, start: "s" } } },
                { data: { frameFileIds: { start: "s" }, imageFileId: "a" } },
                { data: { frameFileIds: "nope" } },
            ],
        };

        expect(workflowFileIds(captured)).toStrictEqual(["e", "s", "a"]);
    });
});

describe("countedWorkflowFileIds", () => {
    it("counts only existing files the owner holds a grant for, before and after", async () => {
        const { db } = fakeDb();

        await expect(countedWorkflowFileIds(db, "owner", content("a", "c"), content("a", "b", "c", "d"))).resolves.toStrictEqual({
            next: ["a", "b"],
            previous: ["a"],
        });
    });

    it("counts a file node's file for its owner, and nothing for a foreign file id", async () => {
        const { db } = fakeDb();
        const fileNodes = { nodes: [{ data: { fileId: "a" } }, { data: { fileId: "c" } }] };

        await expect(countedWorkflowFileIds(db, "owner", undefined, fileNodes)).resolves.toStrictEqual({ next: ["a"], previous: [] });
    });

    it("reads nothing for content without files", async () => {
        const { db, reads } = fakeDb();

        await expect(countedWorkflowFileIds(db, "owner", undefined, content())).resolves.toStrictEqual({ next: [], previous: [] });
        expect(reads).toStrictEqual([]);
    });
});

describe("grantWorkflowFiles", () => {
    it("grants a fork's author-held files, file nodes included, and never a foreign one", async () => {
        const { db } = fakeDb();
        const inserted: { fileId: string; userId: string }[] = [];
        const writer = {
            ...(db as Record<string, unknown>),
            insert: async (_table: string, row: { fileId: string; userId: string }) => {
                inserted.push(row);
            },
        };

        await grantWorkflowFiles(writer as never, "owner", "forker", {
            nodes: [{ data: { fileId: "a" } }, { data: { imageFileId: "b" } }, { data: { fileId: "c" } }],
        });

        expect(inserted.map((row) => [row.fileId, row.userId]).toSorted((a, b) => a[0]!.localeCompare(b[0]!))).toStrictEqual([
            ["a", "forker"],
            ["b", "forker"],
        ]);
    });
});

describe("signWorkflowImages", () => {
    it("signs owner-granted files in two batched reads", async () => {
        const { db, reads } = fakeDb();
        const storage = { getSignedUrl: async (key: string) => `https://signed/${key}` };

        const signed = await signWorkflowImages({ db, storage: storage as never }, "owner", content("a", "c", "a"));

        expect(signed.nodes.map((node) => (node.data as { imageUrl?: string }).imageUrl)).toStrictEqual([
            "https://signed/agent-files/a",
            undefined,
            "https://signed/agent-files/a",
        ]);
        expect(reads).toStrictEqual(["chatFileAccess", "chatFiles"]);
    });
});
