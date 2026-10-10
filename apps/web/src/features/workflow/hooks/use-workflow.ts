"use client";

import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import env from "@/lib/env";
import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

import { useWorkflowStore } from "../stores/workflow-store";
import type { WorkflowContent } from "../types";

// `projectId`/`executionId` reach these hooks as plain strings from the
// `/workflow/$workflowId` route param and from the workflow store (which only
// ever stores ids returned by the backend), so the brand is re-applied here at
// the query/mutation boundary.

/**
 * Hook to get a single workflow by project ID.
 */
export const useWorkflow = (projectId: string | undefined) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading: authLoading } = useLunoraAuth();
    const loadContent = useWorkflowStore((state) => state.loadContent);
    const setProjectId = useWorkflowStore((state) => state.setProjectId);

    const shouldQuery = isAuthenticated && !authLoading && !!projectId;

    const { data: workflow, isLoading } = useQuery(
        crpc.workflow.functions.getWorkflow.queryOptions(shouldQuery && projectId ? { projectId: projectId as Id<"projects"> } : skipToken),
    );

    // Load workflow content into store when data changes
    useEffect(() => {
        if (!(workflow && projectId)) {
            return;
        }

        setProjectId(projectId);
        // `workflowContent` is a JSON blob column: codegen types `node.data` as
        // `unknown` and widens the node/edge type unions to `string`. It is only ever
        // written by this editor via `getContent()`, so it really is a `WorkflowContent`.
        loadContent((workflow.workflowContent ?? null) as WorkflowContent | null);
    }, [workflow, projectId, loadContent, setProjectId]);

    return {
        isLoading: authLoading || isLoading,
        workflow,
    };
};

/**
 * Hook to list all workflows for the current user.
 */
export const useWorkflows = (enabled: boolean = true) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();

    const shouldQuery = enabled && isAuthenticated && !isLoading;

    const { data: workflows } = useQuery(
        crpc.workflow.functions.listWorkflows.queryOptions(shouldQuery ? { paginationOpts: { cursor: null, numItems: 100 } } : skipToken),
    );

    return workflows?.page ?? [];
};

/**
 * Hook to create a new workflow.
 */
export const useCreateWorkflow = () => {
    const crpc = useCRPC();

    return useMutation(crpc.workflow.functions.createWorkflow.mutationOptions());
};

/**
 * Hook to save workflow content with debouncing.
 */
export const useSaveWorkflow = (projectId: string | undefined) => {
    const crpc = useCRPC();
    const getContent = useWorkflowStore((state) => state.getContent);
    const setDirty = useWorkflowStore((state) => state.setDirty);

    const mutation = useMutation(crpc.workflow.functions.updateWorkflowContent.mutationOptions());
    const mutationRef = useRef(mutation);

    // Written in an effect, not during render: React can replay or discard a
    // render, and a ref write from a render that never commits would leak.
    useEffect(() => {
        mutationRef.current = mutation;
    });

    const save = useCallback(async () => {
        if (!projectId) {
            return;
        }

        const content = getContent();

        await mutationRef.current.mutateAsync({
            projectId: projectId as Id<"projects">,
            workflowContent: content,
        });
        setDirty(false);
    }, [projectId, getContent, setDirty]);

    return {
        error: mutation.error,
        isSaving: mutation.isPending,
        save,
    };
};

/**
 * Hook to auto-save workflow content.
 */
export const useAutoSaveWorkflow = (projectId: string | undefined, enabled: boolean = true) => {
    const { isSaving, save } = useSaveWorkflow(projectId);
    const isDirty = useWorkflowStore((state) => state.isDirty);

    // Auto-save on changes (debounced)
    useEffect(() => {
        if (!enabled || !isDirty || isSaving) {
            return undefined;
        }

        const timeout = setTimeout(() => {
            save();
        }, 2000); // 2 second debounce

        return () => clearTimeout(timeout);
    }, [enabled, isDirty, isSaving, save]);

    return { isSaving };
};

/**
 * Hook to manage workflow execution.
 * Calls the backend executor action and polls for status updates.
 */
export const useWorkflowExecution = (projectId: string | undefined) => {
    const crpc = useCRPC();
    const setExecutionStatus = useWorkflowStore((state) => state.setExecutionStatus);
    const setNodeExecutionStatus = useWorkflowStore((state) => state.setNodeExecutionStatus);
    const resetExecution = useWorkflowStore((state) => state.resetExecution);

    // Mutation for the backend executor action
    const executeWorkflow = useMutation(crpc.workflow.executor.executeWorkflow.mutationOptions());
    const executeWorkflowRef = useRef(executeWorkflow);

    // Written in an effect, not during render: React can replay or discard a
    // render, and a ref write from a render that never commits would leak.
    useEffect(() => {
        executeWorkflowRef.current = executeWorkflow;
    });

    const execute = useCallback(
        async (variables?: Record<string, string>) => {
            // Read nodes imperatively to avoid stale closure during async execution
            const currentNodes = useWorkflowStore.getState().nodes;

            if (!projectId || currentNodes.length === 0) {
                return undefined;
            }

            // Reset previous execution state
            resetExecution();
            setExecutionStatus("pending");

            // Mark all nodes as pending
            for (const node of currentNodes) {
                setNodeExecutionStatus(node.id, "pending");
            }

            try {
                setExecutionStatus("running");

                // Call the backend executor
                const result = await executeWorkflowRef.current.mutateAsync({
                    projectId: projectId as Id<"projects">,
                    variables,
                });

                if (result.status === "completed") {
                    setExecutionStatus("completed");
                    // Re-read nodes for completion status (may have changed during execution)
                    const latestNodes = useWorkflowStore.getState().nodes;

                    for (const node of latestNodes) {
                        setNodeExecutionStatus(node.id, "completed", {
                            output: result.outputs?.[node.id],
                        });
                    }
                } else {
                    setExecutionStatus("failed");
                }

                return result;
            } catch (error) {
                setExecutionStatus("failed");
                throw error;
            }
        },
        [projectId, resetExecution, setExecutionStatus, setNodeExecutionStatus],
    );

    return {
        error: executeWorkflow.error,
        execute,
        isExecuting: executeWorkflow.isPending,
    };
};

/**
 * Hook to list workflow executions.
 */
export const useWorkflowExecutions = (projectId: string | undefined) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();

    const shouldQuery = isAuthenticated && !isLoading && !!projectId;

    const { data } = useQuery(
        crpc.workflow.functions.listExecutions.queryOptions(
            shouldQuery && projectId ? { paginationOpts: { cursor: null, numItems: 20 }, projectId: projectId as Id<"projects"> } : skipToken,
        ),
    );

    return data?.page ?? [];
};

/**
 * Hook to subscribe to real-time execution status.
 * Uses Lunora queries to get live updates as nodes execute.
 */
export const useExecutionStatus = (executionId: string | undefined) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading: authLoading } = useLunoraAuth();
    const setExecutionStatus = useWorkflowStore((state) => state.setExecutionStatus);
    const setNodeExecutionStatus = useWorkflowStore((state) => state.setNodeExecutionStatus);

    const shouldQuery = isAuthenticated && !authLoading && !!executionId;

    // Subscribe to execution status
    const { data: execution } = useQuery({
        ...crpc.workflow.functions.getExecution.queryOptions(shouldQuery && executionId ? { executionId: executionId as Id<"workflowExecutions"> } : skipToken),
        // Poll frequently during execution
        refetchInterval: (query) => {
            const { data } = query.state;

            // Stop polling once completed/failed/cancelled
            if (data?.status === "completed" || data?.status === "failed" || data?.status === "cancelled") {
                return false;
            }

            return 500; // Poll every 500ms during execution
        },
    });

    // Subscribe to node executions
    const { data: nodeExecutions } = useQuery({
        ...crpc.workflow.functions.listNodeExecutions.queryOptions(
            shouldQuery && executionId ? { executionId: executionId as Id<"workflowExecutions"> } : skipToken,
        ),
        refetchInterval: () => {
            // Check parent execution status
            if (execution?.status === "completed" || execution?.status === "failed" || execution?.status === "cancelled") {
                return false;
            }

            return 500;
        },
    });

    // Update store when execution status changes
    useEffect(() => {
        if (execution?.status) {
            setExecutionStatus(execution.status as "pending" | "running" | "completed" | "failed" | "cancelled");
        }
    }, [execution?.status, setExecutionStatus]);

    // Update store when node execution statuses change
    useEffect(() => {
        if (nodeExecutions && Array.isArray(nodeExecutions)) {
            for (const nodeExec of nodeExecutions) {
                setNodeExecutionStatus(nodeExec.nodeId, nodeExec.status, {
                    error: nodeExec.error,
                    input: nodeExec.input,
                    output: nodeExec.output,
                    usage: nodeExec.usage,
                });
            }
        }
    }, [nodeExecutions, setNodeExecutionStatus]);

    return {
        execution,
        isLoading: authLoading,
        nodeExecutions: nodeExecutions ?? [],
    };
};

/**
 * Hook for workflow execution with real-time status updates.
 * Combines execution mutation with status subscription.
 */
export const useWorkflowExecutionWithStatus = (projectId: string | undefined) => {
    const { error, execute, isExecuting } = useWorkflowExecution(projectId);
    const executionId = useWorkflowStore((state) => state.currentExecutionId);
    const setCurrentExecutionId = useWorkflowStore((state) => state.setCurrentExecutionId);

    // Subscribe to status updates when we have an execution ID
    const { execution, nodeExecutions } = useExecutionStatus(executionId ?? undefined);

    const executeWithTracking = async (variables?: Record<string, string>) => {
        const result = await execute(variables);

        if (result?.executionId) {
            setCurrentExecutionId(result.executionId);
        }

        return result;
    };

    return {
        error,
        execute: executeWithTracking,
        execution,
        executionId,
        isExecuting,
        nodeExecutions,
    };
};

/**
 * SSE stream event types from workflow execution
 */
interface StreamEvent {
    error?: string;
    nodeId?: string;
    nodeType?: string;
    output?: unknown;
    status?: string;
    text?: string;
    type: "status" | "node_start" | "node_complete" | "node_error" | "text_chunk" | "complete" | "error";
    usage?: {
        completionTokens: number;
        promptTokens: number;
        totalTokens: number;
    };
}

/**
 * Hook for SSE-based workflow execution with real-time streaming.
 * Provides live text streaming for AI nodes and instant status updates.
 */
export const useWorkflowStreamingExecution = (projectId: string | undefined) => {
    const setExecutionStatus = useWorkflowStore((state) => state.setExecutionStatus);
    const setNodeExecutionStatus = useWorkflowStore((state) => state.setNodeExecutionStatus);
    const resetExecution = useWorkflowStore((state) => state.resetExecution);

    const [isExecuting, setIsExecuting] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const [streamingText, setStreamingText] = useState<Record<string, string>>({});
    const abortControllerRef = useRef<AbortController | null>(null);

    const execute = useCallback(
        async (variables?: Record<string, string>) => {
            // Read nodes imperatively to avoid stale closure during async execution
            const currentNodes = useWorkflowStore.getState().nodes;

            if (!projectId || currentNodes.length === 0) {
                return;
            }

            // Abort any existing execution
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }

            const abortController = new AbortController();

            abortControllerRef.current = abortController;

            // Reset state
            resetExecution();
            setExecutionStatus("pending");
            setIsExecuting(true);
            setError(null);
            setStreamingText({});

            // Mark all nodes as pending
            for (const node of currentNodes) {
                setNodeExecutionStatus(node.id, "pending");
            }

            try {
                setExecutionStatus("running");

                // One Lunora Worker serves the RPC and the HTTP routes, so this
                // is the only origin. (An earlier `.cloud` -> `.site` rewrite
                // used to sit here; under Lunora it was a silent no-op.)
                const response = await fetch(`${env.VITE_LUNORA_URL}/workflow/stream`, {
                    body: JSON.stringify({ projectId, variables }),
                    credentials: "include",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "POST",
                    signal: abortController.signal,
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => {
                        return { error: "Stream failed" };
                    });

                    throw new Error((errorData as { error?: string }).error ?? "Stream failed");
                }

                const reader = response.body?.getReader();

                if (!reader) {
                    throw new Error("No response body");
                }

                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();

                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n\n");

                    buffer = lines.pop() ?? "";

                    for (const line of lines) {
                        if (!line.startsWith("data: ")) {
                            continue;
                        }

                        try {
                            const event: StreamEvent = JSON.parse(line.slice(6));

                            switch (event.type) {
                                case "complete": {
                                    setExecutionStatus("completed");
                                    break;
                                }

                                case "error": {
                                    setExecutionStatus("failed");
                                    setError(new Error(event.error ?? "Workflow failed"));
                                    break;
                                }

                                case "node_complete": {
                                    if (event.nodeId) {
                                        setNodeExecutionStatus(event.nodeId, "completed", {
                                            output: event.output,
                                            usage: event.usage,
                                        });
                                    }

                                    break;
                                }

                                case "node_error": {
                                    if (event.nodeId) {
                                        setNodeExecutionStatus(event.nodeId, "failed", {
                                            error: event.error,
                                        });
                                    }

                                    break;
                                }

                                case "node_start": {
                                    if (event.nodeId) {
                                        setNodeExecutionStatus(event.nodeId, "running");
                                        // Clear any previous streaming text for this node
                                        setStreamingText((previous) => {
                                            return { ...previous, ...(event.nodeId && { [event.nodeId]: "" }) };
                                        });
                                    }

                                    break;
                                }

                                case "status": {
                                    setExecutionStatus(event.status as "running" | "completed" | "failed");
                                    break;
                                }

                                case "text_chunk": {
                                    if (event.nodeId && event.text) {
                                        setStreamingText((previous) => {
                                            return {
                                                ...previous,
                                                ...(event.nodeId && { [event.nodeId]: (previous[event.nodeId] ?? "") + event.text }),
                                            };
                                        });
                                    }

                                    break;
                                }
                                default: {
                                    break;
                                }
                            }
                        } catch (parseError) {
                            console.warn("Failed to parse SSE event:", line, parseError);
                        }
                    }
                }
            } catch (error_) {
                if ((error_ as Error).name === "AbortError") {
                    setExecutionStatus("cancelled");
                } else {
                    setExecutionStatus("failed");
                    setError(error_ instanceof Error ? error_ : new Error("Unknown error"));
                }
            } finally {
                setIsExecuting(false);
                abortControllerRef.current = null;
            }
        },
        [projectId, resetExecution, setExecutionStatus, setNodeExecutionStatus],
    );

    const cancel = useCallback(() => {
        if (!abortControllerRef.current) {
            return;
        }

        abortControllerRef.current.abort();
        setExecutionStatus("cancelled");
    }, [setExecutionStatus]);

    // Cleanup on unmount
    useEffect(
        () => () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        },
        [],
    );

    return {
        cancel,
        error,
        execute,
        isExecuting,
        streamingText,
    };
};
