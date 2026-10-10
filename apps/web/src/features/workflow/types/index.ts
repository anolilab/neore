import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { Edge, Node, Viewport } from "@xyflow/react";

// Node type identifiers
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
    | "audio"
    | "transcription"
    | "code"
    | "file"
    | "output"
    | "branch"
    | "controlnet"
    | "advanced-controls"
    | "group"
    | "comment";

// Base node data that all nodes share.
// The index signature makes every concrete NodeData type compatible with
// React Flow's `Record<string, unknown>` constraint on the Node generic,
// which is required to pass WorkflowNode[] to <ReactFlow nodes={...}>.
export interface BaseNodeData {
    [key: string]: unknown;
    description?: string;
    label: string;
    /** User-locked state – prevents edits when true */
    locked?: boolean;
}

// Text node - input or transform text
export interface TextNodeData extends BaseNodeData {
    content?: string; // For input mode
    mode: "input" | "transform";
    template?: string; // For transform mode (with {{variable}} support)
}

// AI node - process with AI model
export interface AINodeData extends BaseNodeData {
    enabledFeatures?: string[];
    maxTokens?: number;
    model?: string;
    reasoningEffort?: number;
    systemPrompt?: string;
    temperature?: number;
}

// Image node - input or generate images
export interface ImageNodeData extends BaseNodeData {
    aspectRatio?: string; // 1:1, 16:9, 9:16, 4:3, etc.
    imageUrl?: string; // For input mode
    mode: "input" | "generate";
    model?: string; // For generation (fal:flux-dev, fal:flux-pro, fal:sdxl-lightning)
    numImages?: number; // 1-4
    prompt?: string; // For generation
}

// Image-to-Image node - transform images with AI
export interface Img2ImgNodeData extends BaseNodeData {
    model?: string; // fal-ai/flux/dev/image-to-image
    negativePrompt?: string;
    prompt?: string; // Guide the transformation
    strength?: number; // 0-1, how much to change (default 0.75)
}

// Upscale node - enhance image resolution
export interface UpscaleNodeData extends BaseNodeData {
    enhanceDetails?: boolean;
    enhanceFace?: boolean;
    model?: string; // creative-upscaler, clarity-upscaler
    scale?: 2 | 4; // Upscale factor
}

// Inpaint node - edit specific regions of an image
export interface InpaintNodeData extends BaseNodeData {
    maskUrl?: string; // Mask image URL (white = edit, black = keep)
    model?: string; // fal-ai/flux-pro/v1/fill
    negativePrompt?: string;
    prompt: string; // What to generate in the masked area
}

// Outpaint node - expand image canvas beyond original borders
export interface OutpaintNodeData extends BaseNodeData {
    expandDirection: "all" | "left" | "right" | "top" | "bottom"; // Which direction(s) to expand
    expandPixels?: number; // Number of pixels to expand (default 256)
    model?: string; // fal-ai/flux-outpaint, fal-ai/sdxl-outpaint
    negativePrompt?: string;
    prompt?: string; // Guide what to generate in expanded areas
}

// Background Removal node - extract subject from background
export interface BackgroundRemovalNodeData extends BaseNodeData {
    backgroundColor?: string; // Optional replacement color (null = transparent)
    model?: string; // fal-ai/birefnet, fal-ai/remove-background
    outputFormat?: "png" | "webp"; // Output format (png for transparency)
    refineMask?: boolean; // Whether to refine edge detection
}

// Object Editor node - remove or add objects in an image
export interface ObjectEditorNodeData extends BaseNodeData {
    maskUrl?: string; // Mask defining the region to edit
    mode: "remove" | "add"; // Remove object or add new object
    model?: string; // fal-ai/lama for removal, inpaint model for adding
    negativePrompt?: string;
    prompt?: string; // What to add (for "add" mode)
}

// Character Reference node - maintain subject consistency (IP-Adapter)
export interface CharacterRefNodeData extends BaseNodeData {
    mode: "face" | "style" | "composition"; // How to apply the reference
    model?: string; // fal-ai/flux-pro/v1.1/redux, fal-ai/ip-adapter-face-id
    negativePrompt?: string;
    prompt?: string; // Guide the generation
    referenceImages: string[]; // 1-4 reference image URLs
    strength?: number; // 0-1, default 0.8
}

// Style Reference node - apply consistent artistic style
export interface StyleRefNodeData extends BaseNodeData {
    contentImageUrl?: string; // Optional content image to stylize
    model?: string; // fal-ai/flux-redux-style, fal-ai/style-transfer
    negativePrompt?: string;
    preserveContent?: boolean; // Whether to preserve content structure
    prompt?: string; // Guide the generation
    strength?: number; // 0-1, how strongly to apply style
    styleImageUrl?: string; // Reference image for style
}

// Parallel Compare node - run same prompt through multiple models
export interface ParallelCompareNodeData extends BaseNodeData {
    aspectRatio?: string; // Shared aspect ratio
    models: string[]; // Array of model IDs to compare (2-4)
    negativePrompt?: string; // Shared negative prompt
    prompt?: string; // Shared prompt for all models
    showLabels?: boolean; // Show model names on results
}

// Video node - generate videos from text/image
export interface VideoNodeData extends BaseNodeData {
    aspectRatio?: string; // 16:9, 9:16, 1:1, etc.
    duration?: number; // 1-10 seconds
    fps?: number; // Frames per second (24, 30, 60)
    mode: "text-to-video" | "image-to-video";
    model?: string; // fal:mochi-v1, fal:minimax-video, fal:kling-video
    motionStrength?: number; // 0-1, how much motion in the video
    prompt?: string;
}

// Image-to-Video node - animate static images
export interface ImageToVideoNodeData extends BaseNodeData {
    duration?: number; // 1-10 seconds
    fps?: number; // Frames per second
    loop?: boolean; // Whether to create seamless loop
    model?: string; // fal:kling-image-to-video, fal:runway-gen3
    motionStrength?: number; // 0-1, intensity of motion
    prompt?: string; // Motion prompt - describe the animation
}

// ControlNet node - guide image generation with pose/depth/edge detection
export interface ControlNetNodeData extends BaseNodeData {
    controlType: "pose" | "depth" | "canny" | "normal" | "softedge"; // Type of control signal
    endPercent?: number; // 0-1, when to stop applying control (default 1)
    model?: string; // ControlNet model to use
    preprocessor?: string; // Preprocessor model (openpose, depth-anything, canny)
    referenceImageUrl?: string; // Input reference image for preprocessing
    startPercent?: number; // 0-1, when to start applying control (default 0)
    strength?: number; // 0-1, control signal strength (default 0.8)
}

// Advanced Controls node - fine-tune image generation parameters
export interface AdvancedControlsNodeData extends BaseNodeData {
    cfgScale?: number; // Classifier-free guidance scale (1-20, default 7)
    clipSkip?: number; // Skip CLIP layers (0-2, default 0)
    sampler?: "euler" | "euler_a" | "dpm++" | "dpm++_2m" | "ddim" | "lms" | "pndm"; // Sampling algorithm
    scheduler?: "normal" | "karras" | "exponential" | "sgm_uniform"; // Noise scheduler
    seed?: number; // Random seed for reproducibility (null = random)
    steps?: number; // Inference steps (10-150, default 30)
    useRandomSeed?: boolean; // Whether to use random seed each time
}

// Audio node - text-to-speech
export interface AudioNodeData extends BaseNodeData {
    model?: string;
    text?: string; // Static text or use input
    voice?: string;
}

// Transcription node - speech-to-text
export interface TranscriptionNodeData extends BaseNodeData {
    language?: string;
    model?: string; // whisper
}

// Code node - execute code
export interface CodeNodeData extends BaseNodeData {
    code: string;
    language: "javascript" | "typescript" | "python";
}

// File node - file input
export interface FileNodeData extends BaseNodeData {
    fileId?: string;
    fileName?: string;
    fileType?: string;
    fileUrl?: string;
}

// Output node - display results
export interface OutputNodeData extends BaseNodeData {
    outputType: "text" | "image" | "video" | "audio" | "json" | "markdown";
}

// Branch node - conditional branching
export interface BranchNodeData extends BaseNodeData {
    branches: {
        condition?: string;
        id: string;
        label: string;
    }[];
    condition?: string; // JavaScript expression
}

// Group node - container for organizing workflow nodes.
// Reserved for future: color, collapsed state, etc.
export type GroupNodeData = BaseNodeData;

// Comment node - inline documentation / sticky note
export interface CommentNodeData extends BaseNodeData {
    color?: string; // Background color (yellow, blue, green, pink)
    content?: string; // Markdown content
}

// Union of all node data types
export type WorkflowNodeData =
    | TextNodeData
    | AINodeData
    | ImageNodeData
    | Img2ImgNodeData
    | UpscaleNodeData
    | InpaintNodeData
    | OutpaintNodeData
    | BackgroundRemovalNodeData
    | ObjectEditorNodeData
    | CharacterRefNodeData
    | StyleRefNodeData
    | ParallelCompareNodeData
    | VideoNodeData
    | ImageToVideoNodeData
    | ControlNetNodeData
    | AdvancedControlsNodeData
    | AudioNodeData
    | TranscriptionNodeData
    | CodeNodeData
    | FileNodeData
    | OutputNodeData
    | BranchNodeData
    | GroupNodeData
    | CommentNodeData;

// Typed workflow node
export type WorkflowNode = Node<WorkflowNodeData, WorkflowNodeType>;

// Workflow edge (standard React Flow edge)
export type WorkflowEdge = Edge;

// Execution status for nodes
export type NodeExecutionStatus = "idle" | "pending" | "running" | "completed" | "failed" | "skipped";

// Node execution state
export interface NodeExecutionState {
    completedAt?: number;
    error?: string;
    input?: unknown;
    output?: unknown;
    startedAt?: number;
    status: NodeExecutionStatus;
    usage?: {
        completionTokens: number;
        promptTokens: number;
        totalTokens: number;
    };
}

// Workflow execution status
export type WorkflowExecutionStatus = "idle" | "pending" | "running" | "completed" | "failed" | "cancelled";

// Complete workflow content (for saving to DB)
export interface WorkflowContent {
    edges: WorkflowEdge[];
    nodes: WorkflowNode[];
    viewport?: Viewport;
}

// Workflow execution state
export interface WorkflowExecutionState {
    completedAt?: number;
    error?: string;
    executionId?: string;
    nodeStates: Record<string, NodeExecutionState>;
    startedAt?: number;
    status: WorkflowExecutionStatus;
}

// Node configuration metadata
export interface NodeConfig {
    color: string;

    /**
     * `defaultData.label` is the English fallback; `defaultLabel` is the same
     * text as a translatable descriptor. Callers creating a node resolve it
     * (`i18n._(config.defaultLabel)`) and pass it as the label, because the
     * label is persisted and doubles as the node's `{{variable}}` name.
     */
    defaultData: Partial<WorkflowNodeData>;
    defaultLabel: MessageDescriptor;
    description: MessageDescriptor;
    handles: {
        inputs: number;
        outputs: number;
    };
    icon: string;
    label: MessageDescriptor;
    type: WorkflowNodeType;
}

// Node configurations registry
const NODE_CONFIGS: Record<WorkflowNodeType, NodeConfig> = {
    "advanced-controls": {
        color: "#475569",
        defaultData: {
            cfgScale: 7,
            label: "Advanced Controls",
            sampler: "euler_a",
            scheduler: "normal",
            steps: 30,
            useRandomSeed: true,
        } as AdvancedControlsNodeData,
        defaultLabel: msg`Advanced Controls`,
        description: msg`Fine-tune CFG scale, sampler, scheduler, and seed`,
        handles: { inputs: 1, outputs: 1 },
        icon: "SlidersHorizontal",
        label: msg`Advanced Controls`,
        type: "advanced-controls",
    },
    ai: {
        color: "#8b5cf6",
        defaultData: { label: "AI", model: undefined } as AINodeData,
        defaultLabel: msg`AI`,
        description: msg`Process with AI model`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Brain",
        label: msg`AI Model`,
        type: "ai",
    },
    audio: {
        color: "#22c55e",
        defaultData: { label: "Text to Speech" } as AudioNodeData,
        defaultLabel: msg`Text to Speech`,
        description: msg`Convert text to speech`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Volume2",
        label: msg`Audio (TTS)`,
        type: "audio",
    },
    "background-removal": {
        color: "#14b8a6",
        defaultData: {
            label: "Remove Background",
            model: "fal-ai/birefnet",
            outputFormat: "png",
            refineMask: true,
        } as BackgroundRemovalNodeData,
        defaultLabel: msg`Remove Background`,
        description: msg`Remove background and extract subject`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Scissors",
        label: msg`Background Removal`,
        type: "background-removal",
    },
    branch: {
        color: "#f97316",
        defaultData: {
            branches: [
                { id: "true", label: "True" },
                { id: "false", label: "False" },
            ],
            label: "Branch",
        } as BranchNodeData,
        defaultLabel: msg`Branch`,
        description: msg`Conditional branching`,
        handles: { inputs: 1, outputs: 2 },
        icon: "GitBranch",
        label: msg`Branch`,
        type: "branch",
    },
    "character-ref": {
        color: "#f472b6",
        defaultData: {
            label: "Character Reference",
            mode: "face",
            model: "fal-ai/flux-pro-redux",
            referenceImages: [],
            strength: 0.8,
        } as CharacterRefNodeData,
        defaultLabel: msg`Character Reference`,
        description: msg`Maintain subject consistency across generations`,
        handles: { inputs: 1, outputs: 1 },
        icon: "User",
        label: msg`Character Reference`,
        type: "character-ref",
    },
    code: {
        color: "#10b981",
        defaultData: { code: "", label: "Code", language: "javascript" } as CodeNodeData,
        defaultLabel: msg`Code`,
        description: msg`Execute code`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Code",
        label: msg`Code`,
        type: "code",
    },
    comment: {
        color: "#fbbf24",
        defaultData: { color: "#fbbf24", content: "", label: "Comment" } as CommentNodeData,
        defaultLabel: msg`Comment`,
        description: msg`Add notes and annotations to the canvas`,
        handles: { inputs: 0, outputs: 0 },
        icon: "MessageSquare",
        label: msg`Comment`,
        type: "comment",
    },
    controlnet: {
        color: "#7c3aed",
        defaultData: {
            controlType: "pose",
            endPercent: 1,
            label: "ControlNet",
            model: "fal-ai/controlnet-sdxl",
            startPercent: 0,
            strength: 0.8,
        } as ControlNetNodeData,
        defaultLabel: msg`ControlNet`,
        description: msg`Guide generation with pose, depth, or edge detection`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Target",
        label: msg`ControlNet`,
        type: "controlnet",
    },
    file: {
        color: "#f59e0b",
        defaultData: { label: "File" } as FileNodeData,
        defaultLabel: msg`File`,
        description: msg`File input`,
        handles: { inputs: 0, outputs: 1 },
        icon: "File",
        label: msg`File`,
        type: "file",
    },
    group: {
        color: "#6b7280",
        defaultData: { label: "Group" } as GroupNodeData,
        defaultLabel: msg`Group`,
        description: msg`Container for organizing workflow nodes`,
        handles: { inputs: 0, outputs: 0 },
        icon: "BoxSelect",
        label: msg`Group`,
        type: "group",
    },
    image: {
        color: "#ec4899",
        defaultData: { aspectRatio: "1:1", label: "Image", mode: "input", model: "fal:flux-dev" } as ImageNodeData,
        defaultLabel: msg`Image`,
        description: msg`Input or generate images`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Image",
        label: msg`Image`,
        type: "image",
    },
    "image-to-video": {
        color: "#dc2626",
        defaultData: {
            duration: 5,
            fps: 24,
            label: "Image to Video",
            loop: false,
            model: "fal-ai/kling-video/v1.5/pro/image-to-video",
            motionStrength: 0.5,
        } as ImageToVideoNodeData,
        defaultLabel: msg`Image to Video`,
        description: msg`Animate static images with AI`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Film",
        label: msg`Image to Video`,
        type: "image-to-video",
    },
    img2img: {
        color: "#d946ef",
        defaultData: { label: "Image-to-Image", model: "fal-ai/flux/dev/image-to-image", strength: 0.75 } as Img2ImgNodeData,
        defaultLabel: msg`Image-to-Image`,
        description: msg`Transform images with AI guidance`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Wand2",
        label: msg`Image-to-Image`,
        type: "img2img",
    },
    inpaint: {
        color: "#c026d3",
        defaultData: { label: "Inpaint", model: "fal-ai/flux-pro-fill", prompt: "" } as InpaintNodeData,
        defaultLabel: msg`Inpaint`,
        description: msg`Edit specific regions of an image`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Eraser",
        label: msg`Inpaint`,
        type: "inpaint",
    },
    "object-editor": {
        color: "#f43f5e",
        defaultData: {
            label: "Object Editor",
            mode: "remove",
            model: "fal-ai/lama",
        } as ObjectEditorNodeData,
        defaultLabel: msg`Object Editor`,
        description: msg`Remove or add objects in an image`,
        handles: { inputs: 1, outputs: 1 },
        icon: "PenTool",
        label: msg`Object Editor`,
        type: "object-editor",
    },
    outpaint: {
        color: "#9333ea",
        defaultData: {
            expandDirection: "all",
            expandPixels: 256,
            label: "Outpaint",
            model: "fal-ai/flux-outpaint",
        } as OutpaintNodeData,
        defaultLabel: msg`Outpaint`,
        description: msg`Expand image canvas beyond original borders`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Expand",
        label: msg`Outpaint`,
        type: "outpaint",
    },
    output: {
        color: "#06b6d4",
        defaultData: { label: "Output", outputType: "text" } as OutputNodeData,
        defaultLabel: msg`Output`,
        description: msg`Display results`,
        handles: { inputs: 1, outputs: 0 },
        icon: "Monitor",
        label: msg`Output`,
        type: "output",
    },
    "parallel-compare": {
        color: "#0ea5e9",
        defaultData: {
            label: "Parallel Compare",
            models: [],
            showLabels: true,
        } as ParallelCompareNodeData,
        defaultLabel: msg`Parallel Compare`,
        description: msg`Compare outputs from multiple models side-by-side`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Columns",
        label: msg`Parallel Compare`,
        type: "parallel-compare",
    },
    "style-ref": {
        color: "#f59e0b",
        defaultData: {
            label: "Style Reference",
            model: "fal-ai/flux-redux-style",
            preserveContent: true,
            strength: 0.8,
        } as StyleRefNodeData,
        defaultLabel: msg`Style Reference`,
        description: msg`Apply consistent artistic style across generations`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Palette",
        label: msg`Style Reference`,
        type: "style-ref",
    },
    text: {
        color: "#6366f1",
        defaultData: { content: "", label: "Text", mode: "input" } as TextNodeData,
        defaultLabel: msg`Text`,
        description: msg`Input or transform text`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Type",
        label: msg`Text`,
        type: "text",
    },
    transcription: {
        color: "#3b82f6",
        defaultData: { label: "Speech to Text", model: "whisper" } as TranscriptionNodeData,
        defaultLabel: msg`Speech to Text`,
        description: msg`Convert speech to text`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Mic",
        label: msg`Transcription`,
        type: "transcription",
    },
    upscale: {
        color: "#a855f7",
        defaultData: { enhanceDetails: true, enhanceFace: false, label: "Upscale", model: "fal-ai/creative-upscaler", scale: 2 } as UpscaleNodeData,
        defaultLabel: msg`Upscale`,
        description: msg`Enhance image resolution`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Maximize2",
        label: msg`Upscale`,
        type: "upscale",
    },
    video: {
        color: "#ef4444",
        defaultData: { aspectRatio: "16:9", duration: 5, fps: 24, label: "Video", mode: "text-to-video", model: "fal-ai/mochi-v1" } as VideoNodeData,
        defaultLabel: msg`Video`,
        description: msg`Generate videos from text or images`,
        handles: { inputs: 1, outputs: 1 },
        icon: "Video",
        label: msg`Video`,
        type: "video",
    },
};

export default NODE_CONFIGS;
