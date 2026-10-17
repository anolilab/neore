/**
 * `@label` mentions, the video frame handles, and the single-pass template scanner.
 *
 * Pure: this file is bundled into the web app too, so it imports nothing.
 *
 * A mention names a direct upstream node by its label. The scanner walks the template once:
 * `{{name}}` variables and `@label` mentions are replaced as they are met, and inserted text
 * is never scanned again, so a node output that contains `@Other` or `{{x}}` is copied verbatim.
 */

/** What a mention can resolve to: a node's text output, or an image in a reference array. */
export type MentionKind = "text" | "image";

/** A node a mention can name. `replacement` is the text the prompt receives in its place. */
export interface MentionTarget {
    id: string;
    kind: MentionKind;
    label: string;
    replacement: string;
}

/** Node types whose output is text. */
export const TEXT_MENTION_NODE_TYPES: ReadonlyArray<string> = ["text", "ai"];

/** Node types whose output is an image, and so whose output can fill a reference array. */
export const IMAGE_OUTPUT_NODE_TYPES: ReadonlyArray<string> = [
    "image",
    "img2img",
    "upscale",
    "inpaint",
    "outpaint",
    "background-removal",
    "object-editor",
    "character-ref",
    "style-ref",
];

/** Most reference images a generation takes. Equal to `REFERENCE_MEDIA_CAPS.images` (a test pins it). */
export const MAX_WORKFLOW_REFERENCE_IMAGES = 4;

/** A frame a video node exposes as a source handle. */
export const FRAME_KINDS = ["start", "end", "picked"] as const;

export type FrameKind = (typeof FRAME_KINDS)[number];

const FRAME_HANDLE_PREFIX = "frame-";

/** The source handle id for a captured frame. Saved graphs store these ids, so they must not change. */
export const frameHandleId = (kind: FrameKind): string => `${FRAME_HANDLE_PREFIX}${kind}`;

/** The frame a source handle id names, or `undefined` when it is not a frame handle. */
export const parseFrameHandle = (handleId: string | null | undefined): FrameKind | undefined => {
    if (!handleId?.startsWith(FRAME_HANDLE_PREFIX)) {
        return undefined;
    }

    const kind = handleId.slice(FRAME_HANDLE_PREFIX.length);

    return (FRAME_KINDS as ReadonlyArray<string>).includes(kind) ? (kind as FrameKind) : undefined;
};

/** A node as the mention rules read it: its id, type and the label it is named by. */
export interface MentionableNode {
    data: Record<string, unknown>;
    id: string;
    type: string;
}

export interface MentionableEdge {
    source: string;
    target: string;
}

/** A label a prompt may mention, and what kind of value it resolves to. */
export interface MentionCandidate {
    id: string;
    kind: MentionKind;
    label: string;
}

/** Whether a node's output can be used for `kind` right now. The web offers every node, so it passes none. */
export type MentionAvailable = (id: string, kind: MentionKind) => boolean;

const labelOf = (node: MentionableNode): string => (typeof node.data.label === "string" ? node.data.label : "");

/** The direct upstream nodes of `nodeId`, in edge order, one entry per node. */
export const upstreamOf = (nodes: ReadonlyArray<MentionableNode>, edges: ReadonlyArray<MentionableEdge>, nodeId: string): MentionableNode[] => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const sources: MentionableNode[] = [];

    for (const edge of edges) {
        const source = edge.target === nodeId ? byId.get(edge.source) : undefined;

        if (source && !sources.includes(source)) {
            sources.push(source);
        }
    }

    return sources;
};

/**
 * The ids of the image inputs of `nodeId`, in edge order: direct upstream image outputs that
 * `available` for images, capped at {@link MAX_WORKFLOW_REFERENCE_IMAGES}. The image at index `i`
 * is "image i + 1" in a prompt and `referenceImages[i]` in the generation.
 */
export const referenceImageIds = (
    nodes: ReadonlyArray<MentionableNode>,
    edges: ReadonlyArray<MentionableEdge>,
    nodeId: string,
    available: MentionAvailable = () => true,
): string[] =>
    upstreamOf(nodes, edges, nodeId)
        .filter((node) => IMAGE_OUTPUT_NODE_TYPES.includes(node.type) && available(node.id, "image"))
        .slice(0, MAX_WORKFLOW_REFERENCE_IMAGES)
        .map((node) => node.id);

/**
 * The labels `nodeId`'s prompt may mention. Only direct upstream nodes count, and a label shared
 * by two of them is ambiguous, so it resolves to nothing and stays literal. `kinds` narrows what
 * resolves: a text template takes text only, since an image ordinal indexes the reference array.
 */
export const mentionableSources = (
    nodes: ReadonlyArray<MentionableNode>,
    edges: ReadonlyArray<MentionableEdge>,
    nodeId: string,
    kinds: ReadonlyArray<MentionKind> = ["text", "image"],
    available: MentionAvailable = () => true,
): MentionCandidate[] => {
    const sources = upstreamOf(nodes, edges, nodeId);
    const counts = new Map<string, number>();

    for (const source of sources) {
        const key = labelOf(source).toLowerCase();

        if (key) {
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }

    const imageIds = referenceImageIds(nodes, edges, nodeId, available);
    const candidates: MentionCandidate[] = [];

    for (const source of sources) {
        const label = labelOf(source);

        if (!label || counts.get(label.toLowerCase()) !== 1) {
            continue;
        }

        if (kinds.includes("text") && TEXT_MENTION_NODE_TYPES.includes(source.type) && available(source.id, "text")) {
            candidates.push({ id: source.id, kind: "text", label });
        } else if (kinds.includes("image") && imageIds.includes(source.id)) {
            candidates.push({ id: source.id, kind: "image", label });
        }
    }

    return candidates;
};

const VARIABLE = /\{\{(\w+)\}\}/y;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

const isWordChar = (char: string | undefined): boolean => char !== undefined && WORD_CHAR.test(char);

/** Whether `label` occurs at `start` and ends on a boundary, so `@Image #1` does not match `Image #10`. */
const labelAt = (text: string, start: number, label: string): boolean =>
    text.slice(start, start + label.length).toLowerCase() === label.toLowerCase() && !isWordChar(text[start + label.length]);

/**
 * Expand `{{name}}` through `variable` and `@label` through `mentions` in one left-to-right pass.
 *
 * An unresolved token stays literal. When two targets share a label, the first wins; callers
 * exclude ambiguous labels so a mention never silently picks one. The longest label wins over
 * a shorter one that is its prefix.
 */
export const expandTemplate = (template: string, mentions: ReadonlyArray<MentionTarget>, variable: (name: string) => string | undefined): string => {
    const targets = mentions.filter((target) => target.label.length > 0).toSorted((a, b) => b.label.length - a.label.length);
    let text = "";
    let index = 0;

    while (index < template.length) {
        if (template[index] === "{") {
            VARIABLE.lastIndex = index;

            const match = VARIABLE.exec(template);

            if (match) {
                text += variable(match[1]!) ?? match[0];
                index += match[0].length;

                continue;
            }
        }

        if (template[index] === "@" && !isWordChar(template[index - 1])) {
            const target = targets.find((candidate) => labelAt(template, index + 1, candidate.label));

            if (target) {
                text += target.replacement;
                index += 1 + target.label.length;

                continue;
            }
        }

        text += template[index];
        index += 1;
    }

    return text;
};
