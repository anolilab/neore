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

/** A workflow whose file nodes name `ids` by `fileId`: a reference-media node, or a legacy document node. */
const fileNodes = (...ids: string[]) => {
    return {
        nodes: ids.map((fileId) => {
            return { data: { fileId } };
        }),
    };
};

/**
 * A `db` holding chat files: `a` a document, `b` an image, `v` a video and `m` audio, all granted to `owner`;
 * `c` a video granted to someone else only; `d` granted to `owner` but gone.
 */
const fakeDb = () => {
    const reads: string[] = [];
    const grants = [
        { fileId: "a", userId: "owner" },
        { fileId: "b", userId: "owner" },
        { fileId: "c", userId: "someone-else" },
        { fileId: "d", userId: "owner" },
        { fileId: "v", userId: "owner" },
        { fileId: "m", userId: "owner" },
    ];
    const files = [
        { _id: "a", mediaType: "application/pdf", storageId: "agent-files/a" },
        { _id: "b", mediaType: "image/png", storageId: "agent-files/b" },
        { _id: "c", mediaType: "video/mp4", storageId: "agent-files/c" },
        { _id: "v", mediaType: "video/mp4", storageId: "agent-files/v" },
        { _id: "m", mediaType: "audio/mpeg", storageId: "agent-files/m" },
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

    it("lists a file node's file as a candidate; countedWorkflowFileIds decides whether it counts", () => {
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

        await expect(countedWorkflowFileIds(db, "owner", content("b", "c"), content("b", "d", "c", "a"))).resolves.toStrictEqual({
            next: ["b", "a"],
            previous: ["b"],
        });
    });

    it("counts a reference video or audio file node for its owner, once on add and once on release", async () => {
        const { db } = fakeDb();

        await expect(countedWorkflowFileIds(db, "owner", undefined, fileNodes("v", "m"))).resolves.toStrictEqual({ next: ["v", "m"], previous: [] });
        await expect(countedWorkflowFileIds(db, "owner", fileNodes("v"), undefined)).resolves.toStrictEqual({ next: [], previous: ["v"] });
    });

    it("releases the old file and counts the new one when a node swaps its file", async () => {
        const { db } = fakeDb();

        await expect(countedWorkflowFileIds(db, "owner", fileNodes("v"), fileNodes("m"))).resolves.toStrictEqual({ next: ["m"], previous: ["v"] });
    });

    it("never counts a document a file node names, so a legacy workflow releases nothing it never added", async () => {
        const { db } = fakeDb();

        await expect(countedWorkflowFileIds(db, "owner", fileNodes("a"), undefined)).resolves.toStrictEqual({ next: [], previous: [] });
        await expect(countedWorkflowFileIds(db, "owner", undefined, fileNodes("a"))).resolves.toStrictEqual({ next: [], previous: [] });
    });

    it("counts a document while an image node names it, and not once it only sits in a file node", async () => {
        const { db } = fakeDb();

        await expect(countedWorkflowFileIds(db, "owner", content("a"), fileNodes("a"))).resolves.toStrictEqual({ next: [], previous: ["a"] });
    });

    it("keeps nothing alive for a foreign or missing file id, and never decrements it", async () => {
        const { db } = fakeDb();

        await expect(countedWorkflowFileIds(db, "owner", fileNodes("c", "missing"), undefined)).resolves.toStrictEqual({ next: [], previous: [] });
        await expect(countedWorkflowFileIds(db, "owner", undefined, fileNodes("c", "missing"))).resolves.toStrictEqual({ next: [], previous: [] });
    });

    it("reads nothing for content without files", async () => {
        const { db, reads } = fakeDb();

        await expect(countedWorkflowFileIds(db, "owner", undefined, content())).resolves.toStrictEqual({ next: [], previous: [] });
        expect(reads).toStrictEqual([]);
    });
});

/** A `db` for a fork's author: `owner` holds a grant for every file given; the forker holds none yet. */
const grantDb = (files: { _id: string; mediaType: string }[]) => {
    const inserted: { fileId: string; userId: string }[] = [];
    const db = {
        chatFileAccess: {
            findMany: async ({ where }: { where: { fileId: { in: string[] }; userId: string } }) => {
                return {
                    page:
                        where.userId === "owner"
                            ? files
                                  .filter((file) => where.fileId.in.includes(file._id))
                                  .map((file) => {
                                      return { fileId: file._id, userId: "owner" };
                                  })
                            : [],
                };
            },
        },
        chatFiles: {
            findMany: async ({ where }: { where: { _id: { in: string[] } } }) => {
                return { page: files.filter((file) => where._id.in.includes(file._id)) };
            },
        },
        insert: async (_table: string, row: { fileId: string; userId: string }) => {
            inserted.push(row);
        },
    };

    return { db: db as never, inserted };
};

describe("grantWorkflowFiles", () => {
    const files = [
        { _id: "img", mediaType: "image/png" },
        { _id: "clip", mediaType: "video/mp4" },
        { _id: "song", mediaType: "audio/mpeg" },
        { _id: "doc", mediaType: "application/pdf" },
    ];

    it("grants a fork the image files and the reference media, and never a document", async () => {
        const { db, inserted } = grantDb(files);
        const graph = {
            nodes: [{ data: { imageFileId: "img" } }, { data: { fileId: "clip" } }, { data: { fileId: "song" } }, { data: { fileId: "doc" } }],
        };

        await grantWorkflowFiles(db, "owner", "forker", graph);

        expect(inserted.map((row) => row.fileId).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["clip", "img", "song"]);
        expect(inserted.every((row) => row.userId === "forker")).toBe(true);
    });

    it("grants a file node's document to nobody, even when the author holds it", async () => {
        const { db, inserted } = grantDb(files);

        await grantWorkflowFiles(db, "owner", "forker", { nodes: [{ data: { fileId: "doc" } }] });

        expect(inserted).toStrictEqual([]);
    });
});

describe("signWorkflowImages", () => {
    it("signs no file-node file, because only an image node's file is given a URL", async () => {
        const { db, reads } = fakeDb();
        const getSignedUrl = async (key: string) => `https://signed/${key}`;

        const signed = await signWorkflowImages({ db, storage: { getSignedUrl } as never }, "owner", { nodes: [{ data: { fileId: "v" } }] });

        expect(signed.nodes).toStrictEqual([{ data: { fileId: "v" } }]);
        expect(reads).toStrictEqual([]);
    });

    it("signs owner-granted files in two batched reads", async () => {
        const { db, reads } = fakeDb();
        const storage = { getSignedUrl: async (key: string) => `https://signed/${key}` };

        const signed = await signWorkflowImages({ db, storage: storage as never }, "owner", content("b", "c", "b"));

        expect(signed.nodes.map((node) => (node.data as { imageUrl?: string }).imageUrl)).toStrictEqual([
            "https://signed/agent-files/b",
            undefined,
            "https://signed/agent-files/b",
        ]);
        expect(reads).toStrictEqual(["chatFileAccess", "chatFiles"]);
    });
});
