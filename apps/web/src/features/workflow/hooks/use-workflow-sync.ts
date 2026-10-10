import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

import { useWorkflowStore } from "../stores/workflow-store";
import type { WorkflowContent } from "../types";

const SYNC_DEBOUNCE_MS = 1500; // Debounce outgoing saves to 1.5s

/** Default lexicographic (UTF-16 code unit) order — the same order `Array#sort` uses for strings. */
const byCodeUnit = (a: string, b: string): number => {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

/**
 * Compute a simple hash for content comparison.
 * Uses node/edge counts + first/last IDs for fast comparison.
 * Falls back to JSON.stringify for full comparison when hashes differ.
 */
const computeContentFingerprint = (content: WorkflowContent | null): string => {
    if (!content) {
        return "empty";
    }

    const nodes = content.nodes ?? [];
    const edges = content.edges ?? [];
    // Quick fingerprint: counts + first/last IDs
    const nodeIds = nodes.map((n) => n.id).toSorted(byCodeUnit);
    const edgeIds = edges.map((e) => e.id).toSorted(byCodeUnit);

    return `n${nodes.length}:${nodeIds[0] ?? ""}:${nodeIds.at(-1) ?? ""}_e${edges.length}:${edgeIds[0] ?? ""}:${edgeIds.at(-1) ?? ""}`;
};

/**
 * Hook for real-time workflow content synchronization.
 *
 * Handles two-way sync:
 * 1. Local changes → debounced save to Lunora (auto-save)
 * 2. Remote changes → reactive query updates → merge into local store
 *
 * Uses Lunora's reactive queries to detect when another user saves,
 * and content fingerprinting to avoid echo (overwriting our own save).
 *
 * Note: For optimal conflict handling, consider adding a `contentVersion`
 * field to the workflow schema for cheaper comparison.
 */
const useWorkflowSync = (projectId: string | undefined) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading: authLoading } = useLunoraAuth();

    const getContent = useWorkflowStore((state) => state.getContent);
    const loadContent = useWorkflowStore((state) => state.loadContent);
    const isDirty = useWorkflowStore((state) => state.isDirty);
    const setDirty = useWorkflowStore((state) => state.setDirty);

    // Track last saved content for echo suppression
    // Store both fingerprint (fast check) and full JSON (fallback)
    const lastSavedFingerprintRef = useRef<string | null>(null);
    const lastSavedJsonRef = useRef<string | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isSavingRef = useRef(false);

    const shouldQuery = isAuthenticated && !authLoading && !!projectId;

    // Subscribe to the workflow project (reactive — Lunora will push updates)
    // `projectId` arrives as a plain string from the `/workflow/$workflowId` route
    // param, so the brand is re-applied at the query/mutation boundary.
    const { data: workflow } = useQuery(
        crpc.workflow.functions.getWorkflow.queryOptions(shouldQuery && projectId ? { projectId: projectId as Id<"projects"> } : skipToken),
    );

    // Save mutation - use ref to avoid unstable reference resetting debounce
    const saveMutation = useMutation(crpc.workflow.functions.updateWorkflowContent.mutationOptions());
    const saveMutateAsyncRef = useRef(saveMutation.mutateAsync);

    // Written in an effect, not during render: React can replay or discard a
    // render, and a ref write from a render that never commits would leak.
    useEffect(() => {
        saveMutateAsyncRef.current = saveMutation.mutateAsync;
    });

    // Debounced save — pushes local content to Lunora
    const debouncedSave = useCallback(() => {
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
        }

        saveTimerRef.current = setTimeout(async () => {
            if (!projectId || isSavingRef.current) {
                return;
            }

            const content = getContent();
            const fingerprint = computeContentFingerprint(content);
            const contentJson = JSON.stringify(content);

            // Quick check: if fingerprint matches, skip expensive comparison
            if (
                fingerprint === lastSavedFingerprintRef.current && // Double-check with full JSON for edge cases
                contentJson === lastSavedJsonRef.current
            ) {
                return;
            }

            isSavingRef.current = true;

            try {
                await saveMutateAsyncRef.current({
                    projectId: projectId as Id<"projects">,
                    workflowContent: content,
                });
                lastSavedFingerprintRef.current = fingerprint;
                lastSavedJsonRef.current = contentJson;
                setDirty(false);
            } catch (error) {
                console.error("Failed to save workflow:", error);
                // Keep dirty state so user knows save failed
            }

            isSavingRef.current = false;
        }, SYNC_DEBOUNCE_MS);
    }, [projectId, getContent, setDirty]);

    // Auto-save when local state is dirty
    useEffect(() => {
        if (!isDirty || !projectId) {
            return;
        }

        debouncedSave();
    }, [isDirty, projectId, debouncedSave]);

    // Receive remote changes — when workflow data changes in Lunora,
    // update the local store if the change wasn't from us
    useEffect(() => {
        if (!workflow?.workflowContent) {
            return;
        }

        const remoteContent = workflow.workflowContent as WorkflowContent;
        const remoteFingerprint = computeContentFingerprint(remoteContent);

        // Quick check: if fingerprint matches our last save, likely an echo
        if (remoteFingerprint === lastSavedFingerprintRef.current) {
            // Verify with full comparison for edge cases (same structure, different data)
            const remoteJson = JSON.stringify(remoteContent);

            if (remoteJson === lastSavedJsonRef.current) {
                return;
            }
        }

        // If we have unsaved local changes, don't overwrite them —
        // the next save will push them up. This is "last write wins" semantics.
        // For proper conflict resolution, consider operational transforms or CRDTs.
        if (isDirty || isSavingRef.current) {
            return;
        }

        // Apply remote content to local store
        loadContent(remoteContent);
        lastSavedFingerprintRef.current = remoteFingerprint;
        lastSavedJsonRef.current = JSON.stringify(remoteContent);
    }, [workflow?.workflowContent, isDirty, loadContent]);

    // Cleanup on unmount
    useEffect(
        () => () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }
        },
        [],
    );

    return {
        isSyncing: saveMutation.isPending,
        syncError: saveMutation.error,
    };
};

export default useWorkflowSync;
