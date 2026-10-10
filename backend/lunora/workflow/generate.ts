import type { AgentConfig } from "@neore/ai/providers";

/**
 * Prompt-to-Workflow Generator
 *
 * AI-powered action that takes a natural language description and generates
 * a complete workflow (nodes + edges) that can be loaded into the canvas.
 */
import { generateText, Output } from "ai";
import { LunoraError, v } from "lunorash/server";
import z from "zod/v4";

import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";

// Lazy-load agents
let _agentsPromise: Promise<Record<string, AgentConfig>> | undefined;

const getAgents = (): Promise<Record<string, AgentConfig>> => {
    if (!_agentsPromise) {
        _agentsPromise = import("@neore/ai/providers").then(({ buildAgents }) => buildAgents());
    }

    return _agentsPromise;
};

const VALID_NODE_TYPES = [
    "text",
    "ai",
    "image",
    "img2img",
    "upscale",
    "inpaint",
    "outpaint",
    "background-removal",
    "video",
    "image-to-video",
    "audio",
    "transcription",
    "code",
    "file",
    "output",
    "branch",
] as const;

const nodeSchema = z.object({
    data: z.looseObject({
        description: z.string().optional(),
        label: z.string(),
    }),
    id: z.string(),
    position: z.object({ x: z.number(), y: z.number() }),
    type: z.enum(VALID_NODE_TYPES),
});

const edgeSchema = z.object({
    id: z.string(),
    source: z.string(),
    sourceHandle: z.string().optional(),
    target: z.string(),
    targetHandle: z.string().optional(),
});

const workflowSchema = z.object({
    edges: z.array(edgeSchema),
    nodes: z.array(nodeSchema),
});

const SYSTEM_PROMPT = `You are a workflow generator. Given a natural language description, generate a visual node-based workflow as JSON.

Available node types and their purposes:
- "text": Text input or text template transform. Data: { label, mode: "input"|"transform", content?: string, template?: string }
- "ai": AI language model processing. Data: { label, model?: string, systemPrompt?: string, temperature?: number, maxTokens?: number }
- "image": Image input or generation. Data: { label, mode: "input"|"generate", model?: "fal:flux-dev"|"fal:flux-pro", prompt?: string, aspectRatio?: "1:1"|"16:9"|"9:16"|"4:3" }
- "img2img": Image-to-image transform. Data: { label, model?: string, prompt?: string, strength?: number }
- "upscale": Image upscaling. Data: { label, scale?: 2|4, enhanceDetails?: boolean }
- "inpaint": Edit image regions. Data: { label, prompt: string }
- "outpaint": Expand image borders. Data: { label, expandDirection: "all"|"left"|"right"|"top"|"bottom", expandPixels?: number }
- "background-removal": Remove image background. Data: { label }
- "video": Text-to-video or image-to-video. Data: { label, mode: "text-to-video"|"image-to-video", prompt?: string, duration?: number }
- "image-to-video": Animate a static image. Data: { label, prompt?: string, duration?: number }
- "audio": Text-to-speech. Data: { label, text?: string }
- "transcription": Speech-to-text. Data: { label }
- "code": Execute JavaScript/TypeScript code. Data: { label, code: string, language: "javascript"|"typescript" }
- "file": File input. Data: { label }
- "output": Display results. Data: { label, outputType: "text"|"image"|"video"|"audio"|"json" }
- "branch": Conditional branching. Data: { label, condition?: string, branches: [{ id: string, label: string }] }

Rules:
1. Generate unique node IDs like "node-1", "node-2", etc.
2. Generate edge IDs like "edge-1", "edge-2", etc.
3. Position nodes left-to-right with ~300px horizontal spacing and vertically centered
4. Connect nodes with edges following the data flow
5. Edge sourceHandle should be "output-0" and targetHandle should be "input-0" unless the node has multiple outputs
6. Always include an "output" node at the end to display results
7. Keep workflows practical and focused — typically 3-8 nodes
8. Set appropriate outputType on the output node based on the final data type

Return ONLY the JSON object with "nodes" and "edges" arrays.`;

/** Generate a workflow from a natural language prompt */
export const generateWorkflowFromPrompt = authAction
    .use(rateLimit("projects/create"))
    .input({
        prompt: v.string().max(MAX_LENGTH.text),
    })
    .action(async ({ args: input, ctx }) => {
        const agents = await getAgents();
        const agent = agents["gemini-2.0-flash"] ?? agents["claude-sonnet-4-20250514"] ?? Object.values(agents)[0];

        if (!agent?.chat) {
            throw new LunoraError("INTERNAL", "No AI model available for workflow generation");
        }

        const result = await generateText({
            maxOutputTokens: 4000,
            model: agent.chat,
            // `output` / `result.output`, not `experimental_output` — ai@7 promoted
            // structured output out of the experimental namespace on both sides. The
            // result field is no longer optional either, so the "no output" guard
            // below is gone: a missing object now fails inside `generateText`, and
            // `workflowSchema.parse` still catches a shape mismatch.
            output: Output.object({ schema: workflowSchema }),
            prompt: `Generate a workflow for: ${input.prompt}`,
            system: SYSTEM_PROMPT,
            temperature: 0.3,
        });

        const object = result.output;

        const parsed = workflowSchema.parse(object);

        const edges = parsed.edges.map((edge) => {
            return {
                ...edge,
                sourceHandle: edge.sourceHandle ?? "output-0",
                targetHandle: edge.targetHandle ?? "input-0",
                type: "animated" as const,
            };
        });

        ctx.log.event("workflow.generate", {
            edgeCount: edges.length,
            inputTokens: result.usage.inputTokens,
            nodeCount: parsed.nodes.length,
            outputTokens: result.usage.outputTokens,
        });

        return {
            edges,
            nodes: parsed.nodes,
            viewport: { x: 0, y: 0, zoom: 1 },
        };
    });
