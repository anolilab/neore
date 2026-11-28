import { api } from "@neore/backend/api";

import { ago, DAY, HOUR, MINUTE } from "../clock";
import type { LunoraFixture } from "../lunora";
import { lunora } from "../lunora";

/** The id the editor stories open; the route's own id check (`beforeLoad`) does not run in a story. */
export const WORKFLOW_ID = "workflow_editor_1";

const node = (id: string, type: string, x: number, y: number, data: Record<string, unknown>): Record<string, unknown> => {
    return { data, id, position: { x, y }, type };
};

const edge = (source: string, target: string): Record<string, unknown> => {
    return { id: `edge-${source}-${target}`, source, sourceHandle: "output-0", target, targetHandle: "input-0", type: "animated" };
};

const NODES = [
    node("text-1", "text", 160, 300, { content: "A ceramic mug on a linen cloth, soft window light.", label: "Product brief", mode: "input" }),
    node("ai-1", "ai", 560, 240, {
        label: "Write the scene prompt",
        maxTokens: 400,
        model: "gpt-5-mini",
        systemPrompt: "Turn the brief into one image prompt.",
        temperature: 0.7,
    }),
    node("output-1", "output", 950, 300, { label: "Result", outputType: "text" }),
];

const EDGES = [edge("text-1", "ai-1"), edge("ai-1", "output-1")];

const workflowRow = (content: { edges: unknown[]; nodes: unknown[] }, title: string): Record<string, unknown> => {
    return {
        _creationTime: ago(3 * DAY),
        _id: WORKFLOW_ID,
        color: "#8b5cf6",
        description: "Turn a short brief into a finished scene prompt.",
        projectType: "workflow",
        title,
        userId: "user_story",
        workflowContent: { ...content, viewport: { x: 0, y: 0, zoom: 0.75 } },
    };
};

export const EXISTING_WORKFLOW = workflowRow({ edges: EDGES, nodes: NODES }, "Product photo set");

/** A workflow the user just created: no nodes yet. */
export const NEW_WORKFLOW = { ...workflowRow({ edges: [], nodes: [] }, "Untitled Workflow"), description: "" };

const execution = (index: number, status: string, startedAgo: number, durationMs: number | null, error?: string): Record<string, unknown> => {
    return {
        _creationTime: ago(startedAgo),
        _id: `execution_${String(index)}`,
        completedAt: durationMs === null ? null : ago(startedAgo) + durationMs,
        error,
        startedAt: ago(startedAgo),
        status,
    };
};

export const EXECUTIONS = [
    execution(1, "completed", 12 * MINUTE, 6400),
    execution(2, "failed", 3 * HOUR, 2100, "The model rejected the prompt: the input was empty."),
    execution(3, "completed", DAY, 71_000),
];

export const RUNNING_EXECUTIONS = [execution(4, "running", MINUTE, null), ...EXECUTIONS];

const nodeExecution = (index: number, nodeId: string, nodeType: string, status: string, durationMs: number, error?: string): Record<string, unknown> => {
    return { _id: `node_execution_${String(index)}`, completedAt: ago(12 * MINUTE) + durationMs, error, nodeId, nodeType, startedAt: ago(12 * MINUTE), status };
};

export const NODE_EXECUTIONS = [
    nodeExecution(1, "text-1", "text", "completed", 40),
    nodeExecution(2, "ai-1", "ai", "completed", 5900),
    nodeExecution(3, "output-1", "output", "completed", 120),
];

interface WorkflowEditorOptions {
    executions?: Record<string, unknown>[];
    workflow?: Record<string, unknown> | null;
}

/** What opening one workflow reads: the workflow itself, its runs and the node results of each, and who else is in it. */
export const workflowEditorFixtures = (options: WorkflowEditorOptions = {}): LunoraFixture[] => {
    const executions = options.executions ?? EXECUTIONS;

    return [
        lunora(api.workflow.functions.getWorkflow, (options.workflow === undefined ? EXISTING_WORKFLOW : options.workflow) as never),
        lunora(api.workflow.functions.listExecutions, { continueCursor: "", isDone: true, page: executions } as never),
        lunora(
            api.workflow.functions.getExecution,
            (args: { executionId: string }) => (executions.find((entry) => entry["_id"] === args.executionId) ?? null) as never,
        ),
        lunora(api.workflow.functions.listNodeExecutions, NODE_EXECUTIONS as never),
        lunora(api.workflow.presence.listPresence, [] as never),
        lunora(api.workflow.presence.heartbeat, null as never),
        lunora(api.workflow.presence.disconnect, null as never),
        lunora(api.workflow.functions.updateWorkflowContent, null as never),
    ];
};
