import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { WorkflowContent, WorkflowEdge, WorkflowNode, WorkflowNodeData, WorkflowNodeType } from "../types";

/**
 * A template node. Its `label` is a translatable descriptor: it is resolved
 * into the viewer's language when the template is loaded, because the label
 * is persisted with the workflow (and becomes its `{{variable}}` name).
 */
interface TemplateNode {
    data: {
        [key: string]: unknown;
        label: MessageDescriptor;
    };
    id: string;
    position: { x: number; y: number };
    type: WorkflowNodeType;
}

interface TemplateContent {
    edges: WorkflowEdge[];
    nodes: TemplateNode[];
}

/**
 * Workflow template definition
 */
export interface WorkflowTemplate {
    category: "image" | "text" | "video" | "audio" | "automation";
    content: TemplateContent;
    description: MessageDescriptor;
    icon: string;
    id: string;
    name: MessageDescriptor;
    tags?: MessageDescriptor[];
}

/**
 * Create a node with default positions.
 */
const createNode = (id: string, type: WorkflowNodeType, position: { x: number; y: number }, data: TemplateNode["data"]): TemplateNode => {
    return {
        data,
        id,
        position,
        type,
    };
};

/**
 * Turn a template's content into workflow content, resolving each node label
 * into the active locale.
 */
export const resolveTemplateContent = (template: WorkflowTemplate, i18n: I18n): WorkflowContent => {
    return {
        edges: template.content.edges.map((edge) => {
            return { ...edge };
        }),
        nodes: template.content.nodes.map((node): WorkflowNode => {
            return {
                ...node,
                data: { ...node.data, label: i18n._(node.data.label) } as WorkflowNodeData,
            };
        }),
    };
};

/**
 * Create an edge between nodes.
 */
const createEdge = (source: string, target: string): WorkflowEdge => {
    return {
        id: `${source}-${target}`,
        source,
        target,
    };
};

/**
 * Built-in workflow templates
 */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
    {
        category: "image",
        content: {
            edges: [createEdge("text-1", "image-1"), createEdge("image-1", "output-1")],
            nodes: [
                createNode(
                    "text-1",
                    "text",
                    { x: 100, y: 200 },
                    {
                        content: "A serene mountain landscape at sunset with dramatic clouds",
                        label: msg`Prompt`,
                        mode: "input",
                    },
                ),
                createNode(
                    "image-1",
                    "image",
                    { x: 400, y: 200 },
                    {
                        aspectRatio: "16:9",
                        label: msg`Generate Image`,
                        mode: "generate",
                        model: "fal:flux-dev",
                    },
                ),
                createNode(
                    "output-1",
                    "output",
                    { x: 700, y: 200 },
                    {
                        label: msg`Result`,
                        outputType: "image",
                    },
                ),
            ],
        },
        description: msg`Generate an image from a text prompt`,
        icon: "Image",
        id: "text-to-image-basic",
        name: msg`Text to Image`,
        tags: [msg`beginner`, msg`image generation`],
    },
    {
        category: "image",
        content: {
            edges: [createEdge("file-1", "upscale-1"), createEdge("upscale-1", "output-1")],
            nodes: [
                createNode(
                    "file-1",
                    "file",
                    { x: 100, y: 200 },
                    {
                        label: msg`Input Image`,
                    },
                ),
                createNode(
                    "upscale-1",
                    "upscale",
                    { x: 400, y: 200 },
                    {
                        enhanceDetails: true,
                        enhanceFace: true,
                        label: msg`Upscale 4x`,
                        model: "fal-ai/creative-upscaler",
                        scale: 4,
                    },
                ),
                createNode(
                    "output-1",
                    "output",
                    { x: 700, y: 200 },
                    {
                        label: msg`Enhanced Image`,
                        outputType: "image",
                    },
                ),
            ],
        },
        description: msg`Upload an image and upscale it with AI enhancement`,
        icon: "Maximize2",
        id: "image-upscale-enhance",
        name: msg`Upscale & Enhance`,
        tags: [msg`enhancement`, msg`upscaling`],
    },
    {
        category: "image",
        content: {
            edges: [createEdge("file-1", "style-1"), createEdge("file-2", "style-1"), createEdge("style-1", "output-1")],
            nodes: [
                createNode(
                    "file-1",
                    "file",
                    { x: 100, y: 150 },
                    {
                        label: msg`Style Image`,
                    },
                ),
                createNode(
                    "file-2",
                    "file",
                    { x: 100, y: 350 },
                    {
                        label: msg`Content Image`,
                    },
                ),
                createNode(
                    "style-1",
                    "style-ref",
                    { x: 400, y: 250 },
                    {
                        label: msg`Apply Style`,
                        model: "fal-ai/flux-redux-style",
                        preserveContent: true,
                        strength: 0.8,
                    },
                ),
                createNode(
                    "output-1",
                    "output",
                    { x: 700, y: 250 },
                    {
                        label: msg`Styled Result`,
                        outputType: "image",
                    },
                ),
            ],
        },
        description: msg`Apply an artistic style to any image`,
        icon: "Palette",
        id: "style-transfer",
        name: msg`Style Transfer`,
        tags: [msg`style`, msg`artistic`],
    },
    {
        category: "image",
        content: {
            edges: [createEdge("text-1", "compare-1"), createEdge("compare-1", "output-1")],
            nodes: [
                createNode(
                    "text-1",
                    "text",
                    { x: 100, y: 200 },
                    {
                        content: "A futuristic city with flying cars and neon lights",
                        label: msg`Prompt`,
                        mode: "input",
                    },
                ),
                createNode(
                    "compare-1",
                    "parallel-compare",
                    { x: 400, y: 200 },
                    {
                        label: msg`Compare Models`,
                        models: ["fal:flux-dev", "fal:flux-schnell", "fal:sdxl-lightning"],
                        showLabels: true,
                    },
                ),
                createNode(
                    "output-1",
                    "output",
                    { x: 700, y: 200 },
                    {
                        label: msg`Comparison Results`,
                        outputType: "image",
                    },
                ),
            ],
        },
        description: msg`Compare outputs from multiple image models side-by-side`,
        icon: "Columns",
        id: "model-comparison",
        name: msg`Model Comparison`,
        tags: [msg`comparison`, msg`testing`],
    },
    {
        category: "image",
        content: {
            edges: [createEdge("file-1", "char-1"), createEdge("text-1", "char-1"), createEdge("char-1", "output-1")],
            nodes: [
                createNode(
                    "file-1",
                    "file",
                    { x: 100, y: 150 },
                    {
                        label: msg`Reference Photo`,
                    },
                ),
                createNode(
                    "text-1",
                    "text",
                    { x: 100, y: 350 },
                    {
                        content: "in a fantasy forest setting, heroic pose",
                        label: msg`Scene Description`,
                        mode: "input",
                    },
                ),
                createNode(
                    "char-1",
                    "character-ref",
                    { x: 400, y: 250 },
                    {
                        label: msg`Character Reference`,
                        mode: "face",
                        model: "fal-ai/flux-pro-redux",
                        referenceImages: [],
                        strength: 0.8,
                    },
                ),
                createNode(
                    "output-1",
                    "output",
                    { x: 700, y: 250 },
                    {
                        label: msg`Generated Image`,
                        outputType: "image",
                    },
                ),
            ],
        },
        description: msg`Generate images with consistent character appearance`,
        icon: "User",
        id: "character-consistency",
        name: msg`Character Consistency`,
        tags: [msg`character`, msg`consistency`, msg`ip-adapter`],
    },
    {
        category: "image",
        content: {
            edges: [createEdge("file-1", "img2img-1"), createEdge("img2img-1", "output-1")],
            nodes: [
                createNode(
                    "file-1",
                    "file",
                    { x: 100, y: 200 },
                    {
                        label: msg`Source Image`,
                    },
                ),
                createNode(
                    "img2img-1",
                    "img2img",
                    { x: 400, y: 200 },
                    {
                        label: msg`Transform`,
                        model: "fal-ai/flux-dev-img2img",
                        prompt: "in the style of studio ghibli anime",
                        strength: 0.7,
                    },
                ),
                createNode(
                    "output-1",
                    "output",
                    { x: 700, y: 200 },
                    {
                        label: msg`Transformed Image`,
                        outputType: "image",
                    },
                ),
            ],
        },
        description: msg`Transform an image with AI guidance`,
        icon: "Wand2",
        id: "image-to-image-transform",
        name: msg`Image Transform`,
        tags: [msg`transformation`, msg`img2img`],
    },
    {
        category: "image",
        content: {
            edges: [createEdge("file-1", "inpaint-1"), createEdge("file-2", "inpaint-1"), createEdge("inpaint-1", "output-1")],
            nodes: [
                createNode(
                    "file-1",
                    "file",
                    { x: 100, y: 150 },
                    {
                        label: msg`Image`,
                    },
                ),
                createNode(
                    "file-2",
                    "file",
                    { x: 100, y: 350 },
                    {
                        label: msg`Mask`,
                    },
                ),
                createNode(
                    "inpaint-1",
                    "inpaint",
                    { x: 400, y: 250 },
                    {
                        label: msg`Inpaint`,
                        model: "fal-ai/flux-pro-fill",
                        prompt: "a beautiful flower arrangement",
                    },
                ),
                createNode(
                    "output-1",
                    "output",
                    { x: 700, y: 250 },
                    {
                        label: msg`Edited Image`,
                        outputType: "image",
                    },
                ),
            ],
        },
        description: msg`Edit specific regions of an image with AI`,
        icon: "Eraser",
        id: "inpaint-edit",
        name: msg`Inpaint Edit`,
        tags: [msg`inpainting`, msg`editing`],
    },
    {
        category: "video",
        content: {
            edges: [createEdge("text-1", "video-1"), createEdge("video-1", "output-1")],
            nodes: [
                createNode(
                    "text-1",
                    "text",
                    { x: 100, y: 200 },
                    {
                        content: "A drone shot flying over a tropical beach at golden hour",
                        label: msg`Video Description`,
                        mode: "input",
                    },
                ),
                createNode(
                    "video-1",
                    "video",
                    { x: 400, y: 200 },
                    {
                        aspectRatio: "16:9",
                        duration: 5,
                        label: msg`Generate Video`,
                        mode: "text-to-video",
                        model: "fal:mochi-v1",
                    },
                ),
                createNode(
                    "output-1",
                    "output",
                    { x: 700, y: 200 },
                    {
                        label: msg`Video Result`,
                        outputType: "video",
                    },
                ),
            ],
        },
        description: msg`Generate a video from a text description`,
        icon: "Video",
        id: "text-to-video",
        name: msg`Text to Video`,
        tags: [msg`video`, msg`generation`],
    },
    {
        category: "text",
        content: {
            edges: [createEdge("text-1", "ai-1"), createEdge("ai-1", "output-1")],
            nodes: [
                createNode(
                    "text-1",
                    "text",
                    { x: 100, y: 200 },
                    {
                        content: "Explain quantum computing in simple terms",
                        label: msg`User Input`,
                        mode: "input",
                    },
                ),
                createNode(
                    "ai-1",
                    "ai",
                    { x: 400, y: 200 },
                    {
                        label: msg`AI Response`,
                        systemPrompt: "You are a helpful assistant that explains complex topics in simple, easy-to-understand language.",
                        temperature: 0.7,
                    },
                ),
                createNode(
                    "output-1",
                    "output",
                    { x: 700, y: 200 },
                    {
                        label: msg`Response`,
                        outputType: "markdown",
                    },
                ),
            ],
        },
        description: msg`Process text through an AI language model`,
        icon: "Brain",
        id: "ai-chat-pipeline",
        name: msg`AI Chat Pipeline`,
        tags: [msg`chat`, msg`llm`, msg`text processing`],
    },
];

/**
 * Filter the built-in template list down to one category tab.
 */
export const getTemplatesByCategory = (category: WorkflowTemplate["category"]): WorkflowTemplate[] => WORKFLOW_TEMPLATES.filter((t) => t.category === category);

/**
 * Look up a single built-in template by its stable slug.
 */
export const getTemplateById = (id: string): WorkflowTemplate | undefined => WORKFLOW_TEMPLATES.find((t) => t.id === id);

/**
 * Get all template categories.
 */
export const getTemplateCategories = (): WorkflowTemplate["category"][] => {
    const categories = new Set(WORKFLOW_TEMPLATES.map((t) => t.category));

    return [...categories];
};
