import { describe, expect, it } from "vitest";

import { buildKnowledgeCitations, CITATION_PASSAGE_MAX, type KnowledgeHit, mergeKnowledgeSources, readKnowledgeCitation } from "./citations";
import { canReadCollection, planRetrievalScope } from "./scope";

const hit = (id: string, extra: Partial<KnowledgeHit> = {}): KnowledgeHit => {
    return { chunkId: id, chunkIndex: 2, content: `content of ${id}`, fileId: `file-${id}`, fileName: `${id}.pdf`, score: 1, ...extra };
};

describe(buildKnowledgeCitations, () => {
    it("numbers excerpts and sources alike, in retrieval order", () => {
        const { context, sources } = buildKnowledgeCitations([hit("a"), hit("b")]);

        expect(context).toContain("[1] a.pdf (passage 3):\ncontent of a");
        expect(context).toContain("[2] b.pdf (passage 3):\ncontent of b");
        expect(sources.map((source) => readKnowledgeCitation(source.providerMetadata))).toEqual([
            { chunkId: "a", chunkIndex: 2, citation: 1, fileId: "file-a", fileName: "a.pdf", passage: "content of a" },
            { chunkId: "b", chunkIndex: 2, citation: 2, fileId: "file-b", fileName: "b.pdf", passage: "content of b" },
        ]);
        expect(sources[0]).toMatchObject({ filename: "a.pdf", id: "knowledge:a", sourceType: "document", type: "source" });
    });

    it("cites a chunk once, and says nothing when nothing was found", () => {
        expect(buildKnowledgeCitations([hit("a"), hit("a")]).sources).toHaveLength(1);
        expect(buildKnowledgeCitations([])).toEqual({ context: undefined, sources: [] });
    });

    it("clips a stored passage but keeps the whole chunk in the prompt", () => {
        const long = "w".repeat(CITATION_PASSAGE_MAX + 100);
        const { context, sources } = buildKnowledgeCitations([hit("a", { content: long })]);

        expect(context).toContain(long);
        expect(readKnowledgeCitation(sources[0]!.providerMetadata)!.passage).toHaveLength(CITATION_PASSAGE_MAX + 1);
    });
});

describe(mergeKnowledgeSources, () => {
    it("puts knowledge sources first, so their position is their number, and drops stale copies", () => {
        const { sources } = buildKnowledgeCitations([hit("a")]);
        const merged = mergeKnowledgeSources([{ id: "web-1" }, { id: "knowledge:a" }], sources);

        expect(merged.map((source) => source.id)).toEqual(["knowledge:a", "web-1"]);
    });
});

describe(readKnowledgeCitation, () => {
    it("ignores any other source's metadata", () => {
        expect(readKnowledgeCitation(undefined)).toBeUndefined();
        expect(readKnowledgeCitation({ openai: { id: 1 } })).toBeUndefined();
        expect(readKnowledgeCitation({ neoreKnowledge: { chunkId: "a" } })).toBeUndefined();
    });
});

describe(planRetrievalScope, () => {
    const collections = [
        { _id: "mine", userId: "me" },
        { _id: "shared", organizationId: "org", userId: "colleague" },
        { _id: "shared-2", organizationId: "org", userId: "colleague" },
        { _id: "other-org", organizationId: "elsewhere", userId: "stranger" },
        { _id: "private", userId: "stranger" },
    ];
    const none = { projectCollectionIds: [], projectFileIds: [], threadCollectionIds: [], threadFileIds: [] };

    it("unions thread and project links, and groups shared collections by owner", () => {
        const plan = planRetrievalScope(
            { projectCollectionIds: ["shared-2", "mine"], projectFileIds: ["f2", "f1"], threadCollectionIds: ["mine", "shared"], threadFileIds: ["f1"] },
            collections,
            "me",
            new Set(["org"]),
        );

        expect(plan).toEqual({
            fileIds: ["f1", "f2"],
            foreign: [{ collectionIds: ["shared", "shared-2"], ownerId: "colleague" }],
            hasExplicitScope: true,
            ownCollectionIds: ["mine"],
        });
    });

    it("ignores collections the user may not read, and deleted ones", () => {
        const plan = planRetrievalScope({ ...none, threadCollectionIds: ["other-org", "private", "gone", "shared"] }, collections, "me", new Set());

        expect(plan.hasExplicitScope).toBe(false);
        expect(plan.foreign).toEqual([]);
    });

    it("falls back to everything the user owns when nothing is attached", () => {
        expect(planRetrievalScope(none, collections, "me", new Set(["org"])).hasExplicitScope).toBe(false);
    });

    it("reads a collection as its owner or as a member of the org it is shared with", () => {
        expect(canReadCollection({ userId: "me" }, "me", new Set())).toBe(true);
        expect(canReadCollection({ organizationId: "org", userId: "x" }, "me", new Set(["org"]))).toBe(true);
        expect(canReadCollection({ organizationId: null, userId: "x" }, "me", new Set(["org"]))).toBe(false);
    });
});
