import { describe, expect, it } from "vitest";

import { countedWorkflowImageIds, signWorkflowImages, workflowImageFileIds } from "./images";

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

describe("workflowImageFileIds", () => {
    it("returns each distinct image file id once, ignoring nodes without one", () => {
        expect(workflowImageFileIds({ nodes: [{ data: { imageFileId: "a" } }, { data: {} }, { data: { imageFileId: "a" } }, {}] })).toStrictEqual(["a"]);
        expect(workflowImageFileIds(undefined)).toStrictEqual([]);
        expect(workflowImageFileIds({ nodes: "nope" })).toStrictEqual([]);
    });

    it("includes the frames a video node captured, skipping unset ones", () => {
        const captured = {
            nodes: [
                { data: { frameFileIds: { end: "e", picked: undefined, start: "s" } } },
                { data: { frameFileIds: { start: "s" }, imageFileId: "a" } },
                { data: { frameFileIds: "nope" } },
            ],
        };

        expect(workflowImageFileIds(captured)).toStrictEqual(["e", "s", "a"]);
    });
});

describe("countedWorkflowImageIds", () => {
    it("counts only existing files the owner holds a grant for, before and after", async () => {
        const { db } = fakeDb();

        await expect(countedWorkflowImageIds(db, "owner", content("a", "c"), content("a", "b", "c", "d"))).resolves.toStrictEqual({
            next: ["a", "b"],
            previous: ["a"],
        });
    });

    it("reads nothing for content without images", async () => {
        const { db, reads } = fakeDb();

        await expect(countedWorkflowImageIds(db, "owner", undefined, content())).resolves.toStrictEqual({ next: [], previous: [] });
        expect(reads).toStrictEqual([]);
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
