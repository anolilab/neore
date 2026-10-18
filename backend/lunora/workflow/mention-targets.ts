/**
 * What a prompt's `@label` mentions resolve to in a run, and the text template node that uses them.
 *
 * Backend-only: the label rules are pure and live in `mentions.ts`; here they are applied to the
 * outputs a run has produced so far. A label resolves to a text output that is a string, or to an
 * image output that carries a URL, so a mention never names something the run cannot send.
 */
import { type ExecutionContext, extractUrl, getLastOutput, type NodeExecutionResult, type WorkflowNode } from "./core";
import {
    expandTemplate,
    type MentionAvailable,
    type MentionKind,
    type MentionTarget,
    mentionableSources,
    referenceImageIds,
    type TemplateFormat,
} from "./mentions";

const imageUrlOf = (context: ExecutionContext, nodeId: string): string | undefined => extractUrl(context.nodeOutputs[nodeId], "imageUrl");

/** Whether a node's output exists in this run as the kind a mention would use it for. */
const availableIn =
    (context: ExecutionContext): MentionAvailable =>
    (nodeId, kind) =>
        kind === "text" ? typeof context.nodeOutputs[nodeId] === "string" : imageUrlOf(context, nodeId) !== undefined;

/** The ids of the image inputs of `node`, in the order its "image N" mentions and reference array use. */
export const referenceImageSourceIds = (node: WorkflowNode, context: ExecutionContext): string[] =>
    referenceImageIds(context.graph.nodes, context.graph.edges, node.id, availableIn(context));

/** The URLs sent as a node's reference images, in the order its "image N" mentions number them. */
export const referenceImageUrls = (node: WorkflowNode, context: ExecutionContext): string[] =>
    referenceImageSourceIds(node, context).flatMap((id) => {
        const url = imageUrlOf(context, id);

        return url ? [url] : [];
    });

/**
 * The labels a prompt on `node` may mention, with what each one resolves to in this run.
 * `kinds` narrows them: a text template takes text only, since an image ordinal indexes the
 * reference array of the node that consumes the prompt.
 */
export const mentionTargetsFor = (node: WorkflowNode, context: ExecutionContext, kinds?: ReadonlyArray<MentionKind>): MentionTarget[] => {
    const imageIds = referenceImageSourceIds(node, context);

    return mentionableSources(context.graph.nodes, context.graph.edges, node.id, kinds, availableIn(context)).map((candidate) => {
        return {
            id: candidate.id,
            kind: candidate.kind,
            label: candidate.label,
            replacement: candidate.kind === "text" ? (context.nodeOutputs[candidate.id] as string) : `image ${imageIds.indexOf(candidate.id) + 1}`,
        };
    });
};

/**
 * Expand the mentions in a node's own prompt text (an AI node's system prompt, an image node's
 * prompt). Unlike a text template there are no `{{variables}}` here, so they stay literal.
 */
export const expandNodeMentions = (node: WorkflowNode, text: string, context: ExecutionContext, kinds?: ReadonlyArray<MentionKind>): string =>
    expandTemplate(text, mentionTargetsFor(node, context, kinds), () => undefined);

/**
 * Execute a text node
 * - Input mode: returns the static content
 * - Transform mode: applies template substitution using {{variable}} syntax.
 */
export const executeTextNode = (node: WorkflowNode, context: ExecutionContext): NodeExecutionResult => {
    const data = node.data as {
        content?: string;
        format?: TemplateFormat;
        mode: "input" | "transform";
        template?: string;
    };

    if (data.mode === "input") {
        return { output: data.content ?? "", success: true };
    }

    const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

    // One pass over the template: `{{variable}}` and `@mention` are both resolved as they are
    // met, so neither a variable's value nor a mentioned output is scanned for the other.
    const text = expandTemplate(
        data.template ?? "",
        mentionTargetsFor(node, context, ["text"]),
        (variableName) => {
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
                return asText(context.nodeOutputs[variableName]);
            }

            // Check if it's a node ID reference
            for (const [nodeId, output] of Object.entries(context.nodeOutputs)) {
                if (nodeId.includes(variableName) || variableName.includes(nodeId)) {
                    return asText(output);
                }
            }

            // `{{input}}` is the most recent input
            return variableName === "input" ? asText(getLastOutput(context)) : undefined;
        },
        data.format,
    );

    return { output: text, success: true };
};
