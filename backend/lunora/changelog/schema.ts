/**
 * Non-table exports from the original `changelog/schema.ts`.
 *
 * The table definitions moved to the generated top-level `lunora/schema.ts`;
 * these types and validators are still referenced by handlers, so they stay here.
 */
export type ChangelogCategory = {
    name: string;
};

export type ChangelogEntry = {
    categories: ChangelogCategory[];
    commentCount: number;
    content: string; // HTML from Featurebase
    createdAt: string;
    date: string; // ISO 8601
    featuredImage: string | null;
    id: string;
    isPublished: boolean;
    slug: string;
    state: string; // "live" | "draft"
    title: string;
    updatedAt: string;
    url: string;
};
