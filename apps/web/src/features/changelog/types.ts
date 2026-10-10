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
    state: string;
    title: string;
    updatedAt: string;
    url: string;
};
