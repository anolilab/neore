/**
 * Workflow Core Module
 *
 * Shared types, utilities, and node executors used by both
 * the action executor and SSE streaming endpoint.
 */

// ============================================================================
// Types
// ============================================================================

/** Node types supported by the workflow executor */
export type WorkflowNodeType =
    | "text"
    | "ai"
    | "image"
    | "img2img"
    | "upscale"
    | "inpaint"
    | "outpaint"
    | "background-removal"
    | "object-editor"
    | "character-ref"
    | "style-ref"
    | "parallel-compare"
    | "video"
    | "image-to-video"
    | "controlnet"
    | "advanced-controls"
    | "audio"
    | "transcription"
    | "code"
    | "file"
    | "output"
    | "branch";

/** Workflow node as stored in the database */
export interface WorkflowNode {
    data: Record<string, unknown>;
    id: string;
    position: { x: number; y: number };
    type: WorkflowNodeType | string;
}

/** Workflow edge connecting nodes */
export interface WorkflowEdge {
    id: string;
    source: string;
    sourceHandle?: string;
    target: string;
    targetHandle?: string;
}

/** Workflow content structure */
export interface WorkflowContent {
    edges: WorkflowEdge[];
    nodes: WorkflowNode[];
    viewport?: { x: number; y: number; zoom: number };
}

/** Execution context passed between nodes */
export interface ExecutionContext {
    /** Current data being passed through the workflow */
    data?: Record<string, unknown>;
    /** Outputs from each node, keyed by node ID */
    nodeOutputs: Record<string, unknown>;
    /** Variables available for template substitution */
    variables: Record<string, string>;
}

/** Result from executing a single node */
export interface NodeExecutionResult {
    /** For branch nodes: which branch to take */
    branchId?: string;
    error?: string;
    output?: unknown;
    success: boolean;
    usage?: {
        completionTokens: number;
        promptTokens: number;
        totalTokens: number;
    };
}

/** Token usage tracking */
export interface TokenUsage {
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Get the last output from previous nodes (most common input pattern).
 */
export const getLastOutput = (context: ExecutionContext): unknown => {
    const values = Object.values(context.nodeOutputs);

    return values.length > 0 ? values[values.length - 1] : "";
};

/**
 * Get the last output as a string.
 */
export const getLastOutputAsString = (context: ExecutionContext): string => {
    const input = getLastOutput(context);

    return typeof input === "string" ? input : JSON.stringify(input);
};

/**
 * Extract a URL from an input value (handles string or object with url/audioUrl/videoUrl).
 */
export const extractUrl = (value: unknown, ...keys: string[]): string | undefined => {
    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "object" && value !== null) {
        const object = value as Record<string, unknown>;

        for (const key of ["url", ...keys]) {
            if (typeof object[key] === "string") {
                return object[key] as string;
            }
        }
    }

    return undefined;
};

/**
 * Store node output in execution context.
 */
export const storeOutput = (context: ExecutionContext, nodeId: string, output: unknown, label?: string): void => {
    context.nodeOutputs[nodeId] = output;

    if (label) {
        context.variables[label.toLowerCase().replaceAll(/\s+/g, "_")] = typeof output === "string" ? output : JSON.stringify(output);
    }
};

/**
 * Accumulate token usage.
 */
export const accumulateUsage = (total: TokenUsage, usage: TokenUsage | undefined): void => {
    if (!usage) {
        return;
    }

    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    total.totalTokens += usage.totalTokens;
};

/**
 * Create initial token usage.
 */
export const createEmptyUsage = (): TokenUsage => {
    return { completionTokens: 0, promptTokens: 0, totalTokens: 0 };
};

// ============================================================================
// Topological Sort
// ============================================================================

/**
 * Get execution order using Kahn's algorithm (topological sort).
 */
export const getExecutionOrder = (nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] => {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    // Initialize
    for (const node of nodes) {
        inDegree.set(node.id, 0);
        adjacency.set(node.id, []);
    }

    // Build adjacency and in-degree
    for (const edge of edges) {
        const targets = adjacency.get(edge.source) ?? [];

        targets.push(edge.target);
        adjacency.set(edge.source, targets);
        inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }

    // Kahn's algorithm
    const queue: string[] = [];
    const result: string[] = [];

    // Start with nodes that have no dependencies
    for (const [nodeId, degree] of inDegree) {
        if (degree === 0) {
            queue.push(nodeId);
        }
    }

    while (queue.length > 0) {
        const nodeId = queue.shift()!;

        result.push(nodeId);

        const targets = adjacency.get(nodeId) ?? [];

        for (const target of targets) {
            const newDegree = (inDegree.get(target) ?? 1) - 1;

            inDegree.set(target, newDegree);

            if (newDegree === 0) {
                queue.push(target);
            }
        }
    }

    return result;
};

/**
 * Get the source nodes for a target node (nodes that feed into it).
 */
export const getSourceNodes = (nodeId: string, edges: WorkflowEdge[]): string[] => edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);

/**
 * Get input for a node from its source nodes.
 */
export const getNodeInput = (nodeId: string, edges: WorkflowEdge[], context: ExecutionContext): unknown => {
    const sourceIds = getSourceNodes(nodeId, edges);

    if (sourceIds.length === 0) {
        return undefined;
    }

    if (sourceIds.length === 1) {
        return context.nodeOutputs[sourceIds[0]!];
    }

    // Multiple inputs - combine into array
    return sourceIds.map((id) => context.nodeOutputs[id]);
};

// ============================================================================
// Synchronous Node Executors
// ============================================================================

/**
 * Execute a text node
 * - Input mode: returns the static content
 * - Transform mode: applies template substitution using {{variable}} syntax.
 */
export const executeTextNode = (node: WorkflowNode, context: ExecutionContext): NodeExecutionResult => {
    const data = node.data as {
        content?: string;
        mode: "input" | "transform";
        template?: string;
    };

    if (data.mode === "input") {
        return { output: data.content ?? "", success: true };
    }

    // Transform mode: apply template substitution
    let template = data.template ?? "";

    // Replace {{variable}} with values from context
    template = template.replaceAll(/\{\{(\w+)\}\}/g, (_, variableName: string) => {
        // First check explicit variables. `?? …` rather than an `in` guard: a
        // present-but-undefined entry would otherwise return undefined from a
        // replacer that must return a string, which stringifies as "undefined"
        // into the prompt. Falling through to the node-output lookup is right.
        const variable = context.variables[variableName];

        if (variable !== undefined) {
            return variable;
        }

        // Then check node outputs
        if (Object.hasOwn(context.nodeOutputs, variableName)) {
            const value = context.nodeOutputs[variableName];

            return typeof value === "string" ? value : JSON.stringify(value);
        }

        // Check if it's a node ID reference
        for (const [nodeId, output] of Object.entries(context.nodeOutputs)) {
            if (nodeId.includes(variableName) || variableName.includes(nodeId)) {
                return typeof output === "string" ? output : JSON.stringify(output);
            }
        }

        return `{{${variableName}}}`; // Keep unresolved
    });

    // Also support {{input}} to get the most recent input
    if (template.includes("{{input}}")) {
        const lastInput = getLastOutput(context);

        // Function replacement — `lastInput` is a previous node's output and
        // may contain `$&`/`` $` ``/`$'`, which a string replacement would
        // expand against the template rather than inserting literally.
        const resolvedInput = typeof lastInput === "string" ? lastInput : JSON.stringify(lastInput);

        template = template.replaceAll("{{input}}", () => resolvedInput);
    }

    return { output: template, success: true };
};

/**
 * Execute a code node asynchronously.
 */
export const executeCodeNode = async (node: WorkflowNode, context: ExecutionContext): Promise<NodeExecutionResult> => {
    const data = node.data as {
        code: string;
        language?: "javascript" | "typescript" | "python";
    };

    if (data.language === "python") {
        return { error: "Python execution is not yet supported", success: false };
    }

    const input = getLastOutput(context);

    try {
        // Create a sandboxed function with limited scope

        const sandboxed = new Function(
            "input",
            "context",
            "nodeOutputs",
            "variables",
            `
            "use strict";
            return (async () => {
                ${data.code}
            })();
            `,
        );

        // Execute with timeout protection
        const timeout = new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("Code execution timed out (10s limit)")), 10_000);
        });
        const execution = sandboxed(input, context.data ?? {}, context.nodeOutputs, context.variables);
        const result = await Promise.race([execution, timeout]);

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Code execution failed",
            success: false,
        };
    }
};

/**
 * Execute an output node - formats and returns the final result.
 */
export const executeOutputNode = (node: WorkflowNode, context: ExecutionContext): NodeExecutionResult => {
    const data = node.data as {
        outputType?: "text" | "image" | "video" | "audio" | "json" | "markdown";
    };

    const input = getLastOutput(context);
    let output: unknown;

    if (data.outputType === "json") {
        try {
            output = typeof input === "string" ? JSON.parse(input) : input;
        } catch {
            output = input;
        }
    } else {
        output = input;
    }

    return { output, success: true };
};

/**
 * Execute a branch node - evaluates condition to determine which branch to take.
 */
export const executeBranchNode = (node: WorkflowNode, context: ExecutionContext): NodeExecutionResult => {
    const data = node.data as {
        branches: { condition?: string; id: string; label?: string }[];
        condition?: string;
    };

    const input = getLastOutput(context);

    try {
        // Evaluate each branch condition
        for (const branch of data.branches) {
            const condition = branch.condition ?? data.condition;

            if (!condition) {
                continue;
            }

            const evalFunction = new Function("input", "context", "nodeOutputs", "variables", `"use strict"; return Boolean(${condition});`);

            const result = evalFunction(input, context.data ?? {}, context.nodeOutputs, context.variables);

            if (result) {
                return { branchId: branch.id, output: input, success: true };
            }
        }

        // Default to first branch if no condition matched
        const defaultBranch = data.branches[0];

        return { branchId: defaultBranch?.id ?? "false", output: input, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Branch evaluation failed",
            success: false,
        };
    }
};

/**
 * Execute a file node - retrieves file content from storage.
 */
export const executeFileNode = (node: WorkflowNode): NodeExecutionResult => {
    const data = node.data as {
        fileId?: string;
        fileName?: string;
        fileType?: string;
        fileUrl?: string;
    };

    if (data.fileUrl) {
        return {
            output: { name: data.fileName, type: data.fileType, url: data.fileUrl },
            success: true,
        };
    }

    if (!data.fileId) {
        return { error: "No file configured", success: false };
    }

    return {
        output: { fileId: data.fileId, name: data.fileName, type: data.fileType },
        success: true,
    };
};
