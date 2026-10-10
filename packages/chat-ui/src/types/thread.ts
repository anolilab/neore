export interface Thread {
    _creationTime: number;
    _id: string;
    mode?: "image" | "text" | "video";
    model?: string;
    organizationId?: null | string;
    pinnedAt?: number;
    source?: null | string;
    status?: string;
    title?: string;
}
