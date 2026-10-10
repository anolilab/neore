/**
 * Which knowledge a run searches — the pure half of `resolveRetrievalScope`.
 *
 * A thread searches what is attached to it AND to its project: single files
 * (`threadKnowledge`, `projectKnowledge`) and whole collections
 * (`knowledgeCollectionLinks`). With nothing attached it searches every indexed
 * file the user owns, as it always did.
 *
 * Files live on their OWNER's shard. A collection the user owns resolves to
 * files here; an org-shared collection someone else owns resolves to a search
 * on that owner's shard (`knowledge_retrieve.searchSharedCollections`), grouped
 * by owner so each shard is called once. A link to a collection the user may no
 * longer read — deleted, unshared, or they left the organization — is ignored,
 * never an error: the link is theirs, the collection is not.
 */

export interface CollectionAccessRow {
    _id: string;
    organizationId?: string | null;
    userId: string;
}

export interface RetrievalLinks {
    projectCollectionIds: ReadonlyArray<string>;
    projectFileIds: ReadonlyArray<string>;
    threadCollectionIds: ReadonlyArray<string>;
    threadFileIds: ReadonlyArray<string>;
}

export interface RetrievalPlan {
    /** Files named directly by a link. */
    fileIds: string[];
    /** Org-shared collections owned by someone else, per owner. */
    foreign: { collectionIds: string[]; ownerId: string }[];
    /** False when nothing usable is attached: search every file the user owns. */
    hasExplicitScope: boolean;
    /** The user's own collections, resolved to files on this shard. */
    ownCollectionIds: string[];
}

/** Owner, or a member of the organization the collection is shared with. */
export const canReadCollection = (
    collection: Pick<CollectionAccessRow, "organizationId" | "userId">,
    userId: string,
    memberOrganizationIds: ReadonlySet<string>,
): boolean => collection.userId === userId || (!!collection.organizationId && memberOrganizationIds.has(collection.organizationId));

export const planRetrievalScope = (
    links: RetrievalLinks,
    collections: ReadonlyArray<CollectionAccessRow>,
    userId: string,
    memberOrganizationIds: ReadonlySet<string>,
): RetrievalPlan => {
    const byId = new Map(collections.map((collection) => [collection._id, collection]));
    const fileIds = [...new Set([...links.threadFileIds, ...links.projectFileIds])];
    const ownCollectionIds: string[] = [];
    const foreign = new Map<string, string[]>();

    const linkedCollectionIds = new Set([...links.threadCollectionIds, ...links.projectCollectionIds]);

    for (const collectionId of linkedCollectionIds) {
        const collection = byId.get(collectionId);

        if (!collection || !canReadCollection(collection, userId, memberOrganizationIds)) {
            continue;
        }

        if (collection.userId === userId) {
            ownCollectionIds.push(collectionId);
        } else {
            foreign.set(collection.userId, [...(foreign.get(collection.userId) ?? []), collectionId]);
        }
    }

    return {
        fileIds,
        foreign: [...foreign].map(([ownerId, collectionIds]) => {
            return { collectionIds, ownerId };
        }),
        hasExplicitScope: fileIds.length > 0 || ownCollectionIds.length > 0 || foreign.size > 0,
        ownCollectionIds,
    };
};
