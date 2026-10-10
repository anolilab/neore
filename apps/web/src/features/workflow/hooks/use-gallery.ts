"use client";

import { api } from "@neore/backend/api";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { createLunoraActionQueryOptions, useCRPC, useLunora, useLunoraActionOptions } from "@/lib/lunora/crpc";

export type GalleryCategory = "image" | "text" | "video" | "audio" | "automation";
export type GallerySortOption = "recent" | "popular" | "most-forked";

/**
 * Gallery card projection of a `projects` row. `galleryCategory`/`galleryFeatured`
 * are absent from the narrower `getFeaturedWorkflows` projection (where "featured"
 * is implied), so they are optional here.
 */
export interface GalleryWorkflow {
    _id: string;
    color?: string;
    description?: string;
    edgeCount?: number;
    galleryCategory?: GalleryCategory;
    galleryFeatured?: boolean;
    galleryForkCount: number;
    galleryPublishedAt?: number;
    galleryTags: string[];
    galleryViewCount: number;
    icon?: string;
    nodeCount: number;
    publicAccessToken?: string;
    title: string;
}

/**
 * Hook to browse the community gallery.
 */
export const useGalleryWorkflows = (options?: { category?: GalleryCategory; enabled?: boolean; sort?: GallerySortOption }) => {
    const crpc = useCRPC();
    const { category, enabled = true, sort = "recent" } = options ?? {};

    const { data, isLoading, refetch } = useQuery(
        crpc.workflow.gallery.browseGallery.queryOptions(enabled ? { category, cursor: null, limit: 30, sort } : skipToken),
    );

    const workflows = useMemo(() => (data?.page ?? []) as GalleryWorkflow[], [data]);
    const nextCursor = data?.nextCursor ?? null;

    return { isLoading, nextCursor, refetch, workflows };
};

/**
 * Hook to get featured workflows for the gallery homepage.
 */
export const useFeaturedWorkflows = () => {
    const crpc = useCRPC();

    const { data, isLoading } = useQuery(crpc.workflow.gallery.getFeaturedWorkflows.queryOptions({}));

    return {
        featured: (data ?? []) as GalleryWorkflow[],
        isLoading,
    };
};

/**
 * Hook to get a public workflow by share token.
 */
export const usePublicWorkflow = (token: string | undefined) => {
    const client = useLunora();

    // An action: the workflow's media is signed on its author's shard (docs/plans/per-user-sharding.md).
    const { data, isLoading } = useQuery({
        ...createLunoraActionQueryOptions(client, api.workflow.gallery.getPublicWorkflow, { publicAccessToken: token ?? "" }),
        enabled: token !== undefined,
    });

    return { isLoading, workflow: data ?? null };
};

/**
 * Hook to publish a workflow to the community gallery.
 */
export const usePublishWorkflow = () => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    return useMutation({
        ...crpc.workflow.gallery.publishWorkflow.mutationOptions(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["workflow"] });
        },
    });
};

/**
 * Hook to unpublish a workflow from the community gallery.
 */
export const useUnpublishWorkflow = () => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    return useMutation({
        ...crpc.workflow.gallery.unpublishWorkflow.mutationOptions(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["workflow"] });
        },
    });
};

/**
 * Hook to update gallery metadata for a published workflow.
 */
export const useUpdateGalleryMeta = () => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    return useMutation({
        ...crpc.workflow.gallery.updateGalleryMeta.mutationOptions(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["workflow"] });
        },
    });
};

/**
 * Hook to fork a public workflow into the user's workspace.
 */
export const useForkWorkflow = () => {
    const queryClient = useQueryClient();
    // An action: a fork reads the author's shard and writes the forker's.
    const forkOptions = useLunoraActionOptions(api.workflow.fork.forkWorkflow);

    return useMutation({
        ...forkOptions,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["workflow"] });
        },
    });
};
