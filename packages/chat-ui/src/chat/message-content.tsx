/**
 * MessageContent - Renders message parts using Streamdown
 *
 * Directly renders ChatMessage.parts without conversion:
 * - text: Markdown content via Streamdown
 * - reasoning: Collapsible reasoning blocks
 * - tool-*: Tool call/result displays
 * - source-url/source-document: Source citations
 * - image/file: Media attachments
 * - data-*: Custom data parts
 */

import { useLingui } from "@lingui/react/macro";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@neore/ui/components/ai-elements/reasoning";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@neore/ui/components/ai-elements/sources";
import AnimatedTiles from "@neore/ui/components/animated-tiles";
import useStreamdownAppearance from "@neore/ui/hooks/use-streamdown-appearance";
import useStreamdownPlugins from "@neore/ui/hooks/use-streamdown-plugins";
import { AlertCircle, ChevronDown, ChevronRight, FileIcon, Globe, Loader2, Play, Presentation, Terminal } from "lucide-react";
import type { FC, ReactNode } from "react";
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import type { ChatMessage, FilePart, ImagePart, MessagePart, ReasoningPart, SourceDocumentPart, SourceUrlPart, TextPart, ToolPart } from "../types/message";
import type { SandboxOutputs } from "../types/sandbox";
import { createCitationMarker, safeHttpUrl } from "../utils/citation-marker";
import cn from "../utils/cn";
import { resolveDeviceToolName } from "../utils/device-tool-name";
import { mcpToolMetaKey, resolveMcpToolName } from "../utils/mcp-tool-name";
import { getPageContextInfo } from "../utils/page-context";
import { SANDBOX_FILE_TOOL_TYPES, sandboxOutputsOf } from "../utils/sandbox-files";
import PageContextChip from "./page-context-chip";

// Lazy-loaded file renderers (code-split per file type)
const LazyGenericFileCard = lazy(() => import("@neore/ui/components/file-renderers/generic-file-card"));
const PdfViewer = lazy(() => import("@neore/ui/components/file-renderers/pdf-viewer"));
const VideoPlayer = lazy(() => import("@neore/ui/components/file-renderers/video-player"));
const AudioWaveformPlayer = lazy(() => import("@neore/ui/components/file-renderers/audio-waveform-player"));
const DocxPreview = lazy(() => import("@neore/ui/components/file-renderers/docx-preview"));

// Inline file type predicates (avoids static import from lazy-loaded library)
const isPdfFile = (mediaType?: string, filename?: string): boolean => mediaType === "application/pdf" || filename?.toLowerCase().endsWith(".pdf") === true;
const isVideoFile = (mediaType?: string, filename?: string): boolean => {
    if (mediaType?.startsWith("video/") || mediaType === "application/vnd.apple.mpegurl") {
        return true;
    }

    const extension = filename?.split(".").pop()?.toLowerCase() ?? "";

    return ["avi", "m3u8", "mkv", "mov", "mp4", "ogg", "webm"].includes(extension);
};
const isAudioFile = (mediaType?: string, filename?: string): boolean => {
    if (mediaType?.startsWith("audio/")) {
        return true;
    }

    const extension = filename?.split(".").pop()?.toLowerCase() ?? "";

    return ["aac", "flac", "m4a", "mp3", "ogg", "wav", "webm"].includes(extension);
};
const isDocxFile = (mediaType?: string, filename?: string): boolean =>
    mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || filename?.toLowerCase().endsWith(".docx") === true;

/** A `[1]`–`[99]` citation marker in a text node. */
const CITATION_MARKER_PATTERN = /\[\d{1,2}\]/;

/** Stable empty default so the prop identity does not change per render. */
const NO_COMPONENTS: NonNullable<MessageContentProps["components"]> = {};

// Generation markers used by backend
const IMAGE_GENERATING_MARKER = "__IMAGE_GENERATING__";
const VIDEO_GENERATING_MARKER = "__VIDEO_GENERATING__";
const AUDIO_GENERATING_MARKER = "__AUDIO_GENERATING__";

interface MessageContentProps {
    /** The accessible name of the inline `[n]` citation marker for source `n` — pass a translated one. Keep it stable (module scope or memoized). */
    citationLabel?: (index: number) => string;
    className?: string;
    components?: {
        /**
         * Rendered for every call of a tool that runs on the user's own computer
         * (`utils/device-tool-name.ts`), in every state after approval — its
         * progress (approval prompt on the device, running) lives outside the message.
         */
        DeviceToolCall?: FC<{ part: ToolPart }>;
        DocumentArtifact?: FC<{ documentId: string; kind: string; title: string; version: number }>;
        File?: FC<{ part: FilePart }>;
        Image?: FC<{ part: ImagePart }>;
        McpApp?: FC<{ part: ToolPart; resourceUri: string; serverName: string; toolName: string }>;
        PresentationArtifact?: FC<{ presentationId: string; slideCount: number; styleName?: string; title: string }>;
        Reasoning?: FC<{ isStreaming?: boolean; text: string }>;
        /** Files a code-execution or shell run saved to its output directory (`utils/sandbox-files.ts`). */
        SandboxFiles?: FC<SandboxOutputs>;
        SourceGroup?: FC<{ sources: (SourceDocumentPart | SourceUrlPart)[] }>;
        Text?: FC<{ isAnimating: boolean; text: string }>;
        /** Rendered for a tool call awaiting the user's approval (`state: "approval-requested"`). */
        ToolApproval?: FC<{ part: ToolPart }>;
        ToolCall?: FC<{ part: ToolPart }>;
        toolMeta?: Map<string, { resourceUri: string; serverName: string }>;

        /**
         * Map of tool name → a view of the whole tool part, rendered in every state
         * after approval (including while the tool is still running). For tools
         * whose progress lives outside the message, such as a long background run.
         */
        toolViews?: Record<string, FC<{ part: ToolPart }>>;
        /** Map of tool name → widget component. When a tool result matches, renders the widget instead of raw JSON. */
        toolWidgets?: Record<string, FC<{ output: unknown }>>;
    };
    isStreaming?: boolean;
    message: ChatMessage;
}

/**
 * Default Text renderer using Streamdown. Math and mermaid load on demand
 * (`useStreamdownPlugins`), so they stay off the startup path.
 */
const DefaultText: FC<{ isAnimating: boolean; text: string }> = memo(({ isAnimating, text }) => {
    const plugins = useStreamdownPlugins(text);
    // The user's code / diagram themes (Appearance settings), provided by the app.
    const { mermaidTheme, shikiTheme } = useStreamdownAppearance();
    const mermaid = useMemo(() => {
        return { config: { theme: mermaidTheme } };
    }, [mermaidTheme]);

    return (
        <Streamdown className="streamdown-animate" isAnimating={isAnimating} mermaid={mermaid} plugins={plugins} shikiTheme={shikiTheme}>
            {text}
        </Streamdown>
    );
});

DefaultText.displayName = "DefaultText";

/**
 * Default Reasoning renderer with collapsible
 */
const DefaultReasoning: FC<{ isStreaming?: boolean; text: string }> = memo(({ isStreaming = false, text }) => (
    <Reasoning isStreaming={isStreaming}>
        <ReasoningTrigger />
        <ReasoningContent>{text}</ReasoningContent>
    </Reasoning>
));

DefaultReasoning.displayName = "DefaultReasoning";

const makeDefaultToolCall = (
    McpApp?: FC<{ part: ToolPart; resourceUri: string; serverName: string; toolName: string }>,
    toolMeta?: Map<string, { resourceUri: string; serverName: string }>,
): FC<{ part: ToolPart }> => {
    const DefaultToolCall: FC<{ part: ToolPart }> = memo(({ part }) => {
        const { t } = useLingui();
        const [isExpanded, setIsExpanded] = useState(false);
        const rawToolName = part.type.replace("tool-", "");
        const mcpInfo = resolveMcpToolName(part);
        const displayName = mcpInfo ? mcpInfo.toolName : rawToolName;
        const isError = part.state === "output-error";
        const isLoading = part.state === "input-streaming" || part.state === "input-available";
        const hasOutput = part.state === "output-available" || isError;

        // By real names first; the runtime-name key only matches unlabelled (older) parts.
        const meta = toolMeta && mcpInfo ? (toolMeta.get(mcpToolMetaKey(mcpInfo.serverName, mcpInfo.toolName)) ?? toolMeta.get(rawToolName)) : undefined;
        const hasMcpApp = !!meta && !!McpApp && hasOutput;

        return (
            <div
                className={cn(
                    "mb-4 rounded-lg border",
                    isError
                        ? "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/50"
                        : "border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50",
                )}
            >
                <button
                    aria-expanded={isExpanded}
                    className={cn(
                        "flex w-full items-center gap-2 p-3 text-left text-sm font-medium",
                        isError ? "text-red-800 dark:text-red-200" : "text-gray-800 dark:text-gray-200",
                    )}
                    onClick={() => setIsExpanded(!isExpanded)}
                    type="button"
                >
                    {isExpanded ? <ChevronDown aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}
                    <span className="font-mono">{displayName}</span>
                    {mcpInfo && (
                        <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/50 dark:text-purple-300">
                            {mcpInfo.serverName}
                        </span>
                    )}
                    {isLoading && <span className="ml-2 animate-pulse text-xs opacity-60">{t`Running...`}</span>}
                    {isError && <AlertCircle aria-hidden="true" className="ml-2 size-4 text-red-500" />}
                </button>

                {/* MCP App interactive view — shown directly below the header when available */}
                {hasMcpApp && McpApp && (
                    <div className="border-t border-gray-200 p-3 dark:border-gray-700">
                        <McpApp part={part} resourceUri={meta.resourceUri} serverName={meta.serverName} toolName={mcpInfo!.toolName} />
                    </div>
                )}

                {/* Collapsible JSON details — always available for debugging */}
                {isExpanded && (
                    <div
                        className={cn(
                            "border-t p-3 text-sm",
                            isError
                                ? "border-red-200 text-red-700 dark:border-red-800 dark:text-red-300"
                                : "border-gray-200 text-gray-700 dark:border-gray-700 dark:text-gray-300",
                        )}
                    >
                        {!!part.input && (
                            <div className="mb-2">
                                <span className="text-xs font-semibold uppercase opacity-60">{t`Input:`}</span>
                                <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                                    {String(typeof part.input === "string" ? part.input : JSON.stringify(part.input, null, 2))}
                                </pre>
                            </div>
                        )}
                        {!!part.output && (
                            <div>
                                <span className="text-xs font-semibold uppercase opacity-60">{t`Output:`}</span>
                                <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                                    {String(typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2))}
                                </pre>
                            </div>
                        )}
                        {part.errorText && (
                            <div className="text-red-600 dark:text-red-400">
                                <span className="text-xs font-semibold uppercase opacity-60">{t`Error:`}</span>
                                <pre className="mt-1 font-mono text-xs whitespace-pre-wrap">{part.errorText}</pre>
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    });

    DefaultToolCall.displayName = "DefaultToolCall";

    return DefaultToolCall;
};

/**
 * Default Source renderer - renders a group of sources in a collapsible.
 * `firstIndex` numbers them from a later position when an app renders the
 * earlier sources itself (a `SourceGroup` override delegating the rest here).
 */
export const DefaultSourceGroup: FC<{ firstIndex?: number; sources: (SourceDocumentPart | SourceUrlPart)[] }> = memo(({ firstIndex = 1, sources }) => {
    const { t } = useLingui();

    if (sources.length === 0) {
        return null;
    }

    const sourceUrls = sources.filter((s): s is SourceUrlPart => s.type === "source-url").map((s) => s.url);

    return (
        <Sources>
            <SourcesTrigger count={sources.length} sourceUrls={sourceUrls} />
            <SourcesContent>
                {sources.map((source, index) => {
                    if (source.type === "source-url") {
                        return (
                            <Source href={safeHttpUrl(source.url) ?? "#"} index={index + firstIndex} key={source.sourceId} title={source.title || source.url} />
                        );
                    }

                    return <Source href="#" index={index + firstIndex} key={source.sourceId} title={source.title || source.filename || t`Document`} />;
                })}
            </SourcesContent>
        </Sources>
    );
});

DefaultSourceGroup.displayName = "DefaultSourceGroup";

/**
 * Loading card shown while createPresentation tool is executing.
 * Transitions to PresentationArtifact once the tool completes.
 */
const PresentationGenerating: FC<{ title?: string }> = memo(({ title }) => {
    const { t } = useLingui();

    return (
        <div className="my-2 flex w-full max-w-sm items-center gap-3 rounded-lg border p-3">
            <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md">
                <Presentation className="text-muted-foreground size-5" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{title || t`Generating presentation...`}</div>
                <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                    {t`Creating slides...`}
                </div>
            </div>
        </div>
    );
});

PresentationGenerating.displayName = "PresentationGenerating";

/**
 * Lightweight fallback shown while file renderer components lazy-load
 */
const FileLoadingFallback: FC<{ name?: string }> = memo(({ name }) => {
    const { t } = useLingui();

    return (
        <div className="my-2 flex w-full max-w-sm items-center gap-3 rounded-lg border p-3">
            <div className="bg-muted flex size-10 shrink-0 animate-pulse items-center justify-center rounded-md" />
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{name || t`Loading file…`}</div>
                <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                    {t`Loading…`}
                </div>
            </div>
        </div>
    );
});

FileLoadingFallback.displayName = "FileLoadingFallback";

/**
 * Placeholder shown when an image is blocked by the NSFW classifier
 * or is still being checked.
 */
const NsfwBlockedPlaceholder: FC<{ nsfwStatus: string }> = memo(({ nsfwStatus }) => {
    const { t } = useLingui();

    return (
        <div className="bg-muted mb-4 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8">
            {nsfwStatus === "checking" ? (
                <>
                    <Loader2 className="text-muted-foreground size-8 animate-spin" />
                    <p className="text-muted-foreground text-sm font-medium">{t`Checking image safety...`}</p>
                </>
            ) : (
                <>
                    <AlertCircle className="size-8 text-amber-500" />
                    <p className="text-sm font-medium">{t`This image has been flagged for review`}</p>
                    <p className="text-muted-foreground text-xs">{t`It will be visible once approved by a moderator`}</p>
                </>
            )}
        </div>
    );
});

NsfwBlockedPlaceholder.displayName = "NsfwBlockedPlaceholder";

/**
 * Default Image renderer
 */
const DefaultImage: FC<{ part: ImagePart }> = memo(({ part }) => {
    const { t } = useLingui();

    // Show placeholder for blocked or checking images
    if (part.nsfwStatus === "blocked" || part.nsfwStatus === "checking") {
        return <NsfwBlockedPlaceholder nsfwStatus={part.nsfwStatus} />;
    }

    return (
        <div className="mb-4">
            <img alt={part.prompt || part.filename || t`Image`} className="max-h-[400px] max-w-full rounded-lg object-contain" src={part.image} />
            {part.prompt && (
                <p className="text-muted-foreground mt-1.5 line-clamp-2 text-xs italic" title={part.prompt}>
                    {part.prompt}
                </p>
            )}
            {!part.prompt && part.filename && <p className="text-muted-foreground mt-1 text-xs">{part.filename}</p>}
        </div>
    );
});

DefaultImage.displayName = "DefaultImage";

/**
 * Default File renderer
 */
const DefaultFile: FC<{ part: FilePart }> = memo(({ part }) => {
    const { t } = useLingui();
    const url = part.url || part.data;

    return (
        <a
            className="mb-4 inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            href={url}
            rel="noopener noreferrer"
            target="_blank"
        >
            <FileIcon className="size-4" />
            <span>{part.filename || t`Download file`}</span>
            {part.mediaType && <span className="text-xs opacity-60">({part.mediaType})</span>}
        </a>
    );
});

DefaultFile.displayName = "DefaultFile";

/**
 * Image/Video/Audio Generation Loading renderer
 */
const GenerationLoading: FC<{ type: "audio" | "image" | "video" }> = memo(({ type }) => {
    const { t } = useLingui();
    // Built here, not in a module-level map: a module-scope macro call runs at import, which breaks importers in untranspiled unit tests.
    const labels: Record<"audio" | "image" | "video", string> = {
        audio: t`Generating audio...`,
        image: t`Generating image...`,
        video: t`Generating video...`,
    };
    const label = labels[type];

    if (type === "audio") {
        // Audio generation uses a simple loading spinner
        return (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50">
                <div className="size-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600 dark:border-gray-600 dark:border-t-gray-300" />
                <span className="text-sm text-gray-600 dark:text-gray-400">{label}</span>
            </div>
        );
    }

    // Image/Video generation uses the AnimatedTiles component
    return (
        <div className="mb-4 flex flex-col items-center gap-3">
            <AnimatedTiles
                className="rounded-lg"
                cols={8}
                containerClassName="rounded-lg bg-gray-100 dark:bg-gray-800 p-4"
                gradientColor="rgb(156, 163, 175)"
                rows={8}
                tileSize={40}
            />
            <span className="text-sm text-gray-500 dark:text-gray-400">{label}</span>
        </div>
    );
});

GenerationLoading.displayName = "GenerationLoading";

/**
 * Code Execution Result renderer
 */
interface CodeExecutionOutput {
    error?: string;
    results: {
        format?: string;
        type: "error" | "image" | "text";
        value: string;
    }[];
    stderr: string;
    stdout: string;
}

const CodeExecutionResultView: FC<{ part: ToolPart }> = memo(({ part }) => {
    const { t } = useLingui();
    const [isCodeExpanded, setIsCodeExpanded] = useState(false);
    const isLoading = part.state === "input-streaming" || part.state === "input-available";

    if (isLoading) {
        return (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-800 dark:bg-blue-950/50">
                <div className="size-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600 dark:border-blue-600 dark:border-t-blue-300" />
                <span className="text-sm text-blue-600 dark:text-blue-400">{t`Running code...`}</span>
            </div>
        );
    }

    const isError = part.state === "output-error";
    const output = part.output as CodeExecutionOutput | undefined;
    const input = part.input as { code?: string } | undefined;

    return (
        <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
            {/* Header with code toggle */}
            {input?.code && (
                <button
                    className="dark:hover:bg-gray-750 flex w-full items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 text-left text-xs font-medium text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
                    onClick={() => setIsCodeExpanded(!isCodeExpanded)}
                    type="button"
                >
                    {isCodeExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                    <Play className="size-3" />
                    <span>Python</span>
                </button>
            )}

            {/* Collapsible code block */}
            {isCodeExpanded && input?.code && (
                <div className="border-b border-gray-200 bg-gray-900 p-3 dark:border-gray-700">
                    <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-gray-100">{input.code}</pre>
                </div>
            )}

            {/* Output section */}
            {output && (
                <div className="bg-white dark:bg-gray-900/50">
                    {/* Stdout */}
                    {output.stdout && (
                        <div className="border-b border-gray-100 p-3 dark:border-gray-800">
                            <div className="mb-1 flex items-center gap-1.5">
                                <Terminal className="size-3 text-gray-400" />
                                <span className="text-[10px] font-semibold text-gray-400 uppercase">{t`Output`}</span>
                            </div>
                            <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-gray-700 dark:text-gray-300">{output.stdout}</pre>
                        </div>
                    )}

                    {/* Stderr (warnings) */}
                    {output.stderr && (
                        <div className="border-b border-gray-100 p-3 dark:border-gray-800">
                            <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-yellow-600 dark:text-yellow-400">{output.stderr}</pre>
                        </div>
                    )}

                    {/* Results (images, text, errors) */}
                    {output.results.map((result) => {
                        // Content-based key: stable across re-renders for immutable execution output
                        const resultKey = `${result.type}-${result.value?.slice(0, 20) ?? ""}`;

                        if (result.type === "image") {
                            return (
                                <div className="flex justify-center border-b border-gray-100 p-3 last:border-b-0 dark:border-gray-800" key={resultKey}>
                                    <img
                                        alt={t`Code output`}
                                        className="max-w-full rounded"
                                        src={`data:image/${result.format || "png"};base64,${result.value}`}
                                    />
                                </div>
                            );
                        }

                        if (result.type === "error") {
                            return (
                                <div className="border-b border-gray-100 p-3 last:border-b-0 dark:border-gray-800" key={resultKey}>
                                    <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-red-600 dark:text-red-400">{result.value}</pre>
                                </div>
                            );
                        }

                        if (result.type === "text" && result.value) {
                            return (
                                <div className="border-b border-gray-100 p-3 last:border-b-0 dark:border-gray-800" key={resultKey}>
                                    <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-gray-700 dark:text-gray-300">{result.value}</pre>
                                </div>
                            );
                        }

                        return null;
                    })}

                    {/* Execution error */}
                    {(output.error || isError) && (
                        <div className="flex items-start gap-2 p-3 text-red-600 dark:text-red-400">
                            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                            <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">{output.error || part.errorText || t`Execution failed`}</pre>
                        </div>
                    )}
                </div>
            )}

            {/* Error without output */}
            {!output && isError && (
                <div className="flex items-start gap-2 p-3 text-red-600 dark:text-red-400">
                    <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                    <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">{part.errorText || t`Code execution failed`}</pre>
                </div>
            )}
        </div>
    );
});

CodeExecutionResultView.displayName = "CodeExecutionResultView";

/**
 * Browser Tool Result renderer — shows screenshots inline and action summaries.
 */
/** Tool types whose output renders as a document artifact card. */
const DOCUMENT_ARTIFACT_TOOLS = new Set(["tool-createDocument", "tool-deepResearch", "tool-updateDocument"]);

const BrowserToolResultView: FC<{ part: ToolPart }> = memo(({ part }) => {
    const { t } = useLingui();
    const isLoading = part.state === "input-streaming" || part.state === "input-available";
    const isError = part.state === "output-error";
    const input = part.input as { action?: string; url?: string } | undefined;
    const browserLoadingLabels: Record<string, string> = {
        click: t`Clicking element...`,
        extract: t`Extracting content...`,
        screenshot: t`Taking screenshot...`,
        type: t`Typing text...`,
    };

    if (isLoading) {
        const target = input?.url ?? t`page`;
        const actionLabel = input?.action === "navigate" ? t`Navigating to ${target}...` : (browserLoadingLabels[input?.action ?? ""] ?? t`Browser working...`);

        return (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-800 dark:bg-blue-950/50">
                <div className="size-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600 dark:border-blue-600 dark:border-t-blue-300" />
                <div className="min-w-0 flex-1">
                    <span className="text-sm text-blue-600 dark:text-blue-400">{actionLabel}</span>
                    {input?.url && input.action === "navigate" && <p className="truncate text-[11px] text-blue-500/70 dark:text-blue-400/50">{input.url}</p>}
                </div>
            </div>
        );
    }

    const output = part.output as
        | {
              content?: string;
              error?: string;
              screenshot?: string;
              screenshotFormat?: string;
              success?: boolean;
              title?: string;
              url?: string;
          }
        | undefined;

    // If we have a screenshot, show it prominently
    if (output?.screenshot && output.screenshotFormat) {
        return (
            <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                {/* Header */}
                <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <Globe aria-hidden="true" className="size-3.5 text-blue-500" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-600 dark:text-gray-400">
                        {output.title || output.url || t`Screenshot`}
                    </span>
                    {output.url && (
                        <a className="text-[10px] text-blue-500 hover:underline" href={output.url} rel="noopener noreferrer" target="_blank">
                            {t`Open`}
                        </a>
                    )}
                </div>
                {/* Screenshot */}
                <img alt={output.title || t`Browser screenshot`} className="w-full" src={`data:image/${output.screenshotFormat};base64,${output.screenshot}`} />
            </div>
        );
    }

    // Successful non-screenshot result (extract, navigate, etc.)
    if (output?.success && !isError) {
        const browserDoneLabels: Record<string, string> = {
            extract: t`Extracted`,
            navigate: t`Navigated`,
        };
        const doneLabel = browserDoneLabels[input?.action ?? ""];

        return (
            <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 dark:bg-gray-800">
                    <Globe aria-hidden="true" className="size-3.5 text-green-500" />
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{doneLabel ?? input?.action ?? t`Browser`}</span>
                    {output.title && <span className="min-w-0 truncate text-xs text-gray-500">—{output.title}</span>}
                </div>
                {output.content && (
                    <div className="max-h-40 overflow-y-auto p-3">
                        <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-gray-700 dark:text-gray-300">
                            {output.content.length > 500 ? `${output.content.slice(0, 500)}\n…` : output.content}
                        </pre>
                    </div>
                )}
            </div>
        );
    }

    // Error state
    if (isError || output?.error) {
        return (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-950/50">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
                <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-red-700 dark:text-red-300">{t`Browser error`}</span>
                    <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-red-600 dark:text-red-400">
                        {output?.error || part.errorText || t`Browser action failed`}
                    </pre>
                </div>
            </div>
        );
    }

    // Fallback
    return null;
});

BrowserToolResultView.displayName = "BrowserToolResultView";

/**
 * Main MessageContent component
 */
const MessageContent: FC<MessageContentProps> = memo(({ citationLabel, className, components = NO_COMPONENTS, isStreaming = false, message }) => {
    const { t } = useLingui();
    const resolveCitationLabel = citationLabel ?? ((index: number) => t`Source ${index}`);
    const {
        DeviceToolCall,
        DocumentArtifact,
        Image = DefaultImage,
        McpApp,
        PresentationArtifact,
        Reasoning: ReasoningRenderer = DefaultReasoning,
        SandboxFiles,
        SourceGroup = DefaultSourceGroup,
        Text = DefaultText,
        ToolApproval,
        ToolCall,
        toolMeta,
        toolViews,
        toolWidgets,
    } = components;

    // Build DefaultToolCall with injected McpApp and toolMeta (avoids hook-in-conditional issues).
    // Memoized: a new component type per render would remount every tool call row
    // on each render of this message, dropping its expanded state.
    const ResolvedToolCall = useMemo(() => ToolCall ?? makeDefaultToolCall(McpApp, toolMeta), [McpApp, ToolCall, toolMeta]);

    const isAnimating = isStreaming || message.status === "streaming";

    // Extract generation prompt from metadata (set by generateImage/generateVideo/generateSpeech)
    const generationPrompt = (message.metadata as { prompt?: string } | undefined)?.prompt;

    // Collect all source parts to render them grouped
    const sourceParts: (SourceDocumentPart | SourceUrlPart)[] = [];

    // Render parts
    const renderedParts: ReactNode[] = [];

    for (let i = 0; i < message.parts.length; i += 1) {
        const part = message.parts[i] as MessagePart;
        const key = `${message.id}-part-${i}`;

        switch (part.type as string) {
            case "file": {
                const filePart = part as FilePart;
                const fileUrl = filePart.url || filePart.data;

                // Image — existing handler
                if (filePart.mediaType?.startsWith("image/") && fileUrl) {
                    renderedParts.push(
                        <Image
                            key={key}
                            part={{
                                filename: filePart.filename,
                                image: filePart.url || filePart.data || "",
                                nsfwStatus: filePart.nsfwStatus,
                                prompt: generationPrompt,
                                type: "image",
                            }}
                        />,
                    );
                    // PDF
                } else if (isPdfFile(filePart.mediaType, filePart.filename) && fileUrl) {
                    renderedParts.push(
                        <Suspense fallback={<FileLoadingFallback name={filePart.filename} />} key={key}>
                            <PdfViewer filename={filePart.filename} url={fileUrl} />
                        </Suspense>,
                    );
                    // Video
                } else if (isVideoFile(filePart.mediaType, filePart.filename) && fileUrl) {
                    renderedParts.push(
                        <Suspense fallback={<FileLoadingFallback name={filePart.filename} />} key={key}>
                            <VideoPlayer filename={filePart.filename} mediaType={filePart.mediaType} url={fileUrl} />
                        </Suspense>,
                    );
                    // Audio
                } else if (isAudioFile(filePart.mediaType, filePart.filename) && fileUrl) {
                    renderedParts.push(
                        <Suspense fallback={<FileLoadingFallback name={filePart.filename} />} key={key}>
                            <AudioWaveformPlayer filename={filePart.filename} url={fileUrl} />
                        </Suspense>,
                    );
                    // DOCX
                } else if (isDocxFile(filePart.mediaType, filePart.filename) && fileUrl) {
                    renderedParts.push(
                        <Suspense fallback={<FileLoadingFallback name={filePart.filename} />} key={key}>
                            <DocxPreview filename={filePart.filename} url={fileUrl} />
                        </Suspense>,
                    );
                    // Fallback: enhanced file card (also lazy-loaded)
                } else {
                    renderedParts.push(
                        <Suspense fallback={<FileLoadingFallback name={filePart.filename} />} key={key}>
                            <LazyGenericFileCard filename={filePart.filename} mediaType={filePart.mediaType} url={fileUrl} />
                        </Suspense>,
                    );
                }

                break;
            }

            case "image": {
                const imagePart = part as unknown as ImagePart;

                renderedParts.push(<Image key={key} part={generationPrompt ? { ...imagePart, prompt: generationPrompt } : imagePart} />);
                break;
            }

            case "reasoning": {
                const reasoningPart = part as ReasoningPart;

                if (reasoningPart.text) {
                    // Reasoning is only still streaming while nothing follows it; once the
                    // answer (or a tool call) starts, the panel should collapse.
                    const isReasoningStreaming = isAnimating && i === message.parts.length - 1;

                    renderedParts.push(<ReasoningRenderer isStreaming={isReasoningStreaming} key={key} text={reasoningPart.text} />);
                }

                break;
            }
            case "source-document":
            case "source-url": {
                // Collect sources to render them grouped at the beginning
                const sourcePart = part as SourceDocumentPart | SourceUrlPart;

                sourceParts.push(sourcePart);
                break;
            }

            case "step-start": {
                // Skip step-start markers
                break;
            }

            case "text": {
                const textPart = part as TextPart;
                const pageContext = getPageContextInfo(textPart);

                if (pageContext) {
                    renderedParts.push(<PageContextChip info={pageContext} key={key} text={textPart.text} />);
                    break;
                }

                if (textPart.text) {
                    // Check for generation markers
                    switch (textPart.text) {
                        case AUDIO_GENERATING_MARKER: {
                            renderedParts.push(<GenerationLoading key={key} type="audio" />);

                            break;
                        }
                        case IMAGE_GENERATING_MARKER: {
                            renderedParts.push(<GenerationLoading key={key} type="image" />);

                            break;
                        }
                        case VIDEO_GENERATING_MARKER: {
                            renderedParts.push(<GenerationLoading key={key} type="video" />);

                            break;
                        }
                        default: {
                            renderedParts.push(
                                <div data-markdown-part={textPart.text} key={key}>
                                    <Text isAnimating={isAnimating} text={textPart.text} />
                                </div>,
                            );
                        }
                    }
                }

                break;
            }

            default: {
                // Check for tool- prefixed parts
                if ((part.type as string).startsWith("tool-")) {
                    const toolPart = part as unknown as ToolPart;

                    // A call paused for human approval takes precedence over every
                    // tool-specific view: nothing has run yet, so there is no output.
                    if (toolPart.state === "approval-requested" && ToolApproval) {
                        renderedParts.push(<ToolApproval key={key} part={toolPart} />);
                        break;
                    }

                    if (DeviceToolCall && resolveDeviceToolName(toolPart)) {
                        renderedParts.push(<DeviceToolCall key={key} part={toolPart} />);
                        break;
                    }

                    const ToolView = toolViews?.[part.type.replace("tool-", "")];

                    if (ToolView && toolPart.state !== "input-streaming") {
                        renderedParts.push(<ToolView key={key} part={toolPart} />);
                        break;
                    }

                    // Special rendering for code execution tool
                    // Sandbox output files render under the tool's own view.
                    const sandboxOutputs =
                        SandboxFiles && toolPart.state === "output-available" && SANDBOX_FILE_TOOL_TYPES.has(part.type)
                            ? sandboxOutputsOf(toolPart.output)
                            : null;

                    if (part.type === "tool-codeExecution") {
                        renderedParts.push(<CodeExecutionResultView key={key} part={toolPart} />);

                        if (sandboxOutputs && SandboxFiles) {
                            renderedParts.push(<SandboxFiles key={`${key}-files`} {...sandboxOutputs} />);
                        }

                        break;
                    }

                    // Special rendering for browser tool — show live status or screenshot result
                    if (part.type === "tool-browser") {
                        renderedParts.push(<BrowserToolResultView key={key} part={toolPart} />);
                        break;
                    }

                    // Special rendering for document tools - show artifact card instead of raw JSON
                    if (
                        DOCUMENT_ARTIFACT_TOOLS.has(part.type) &&
                        toolPart.output &&
                        typeof toolPart.output === "object" &&
                        toolPart.state === "output-available"
                    ) {
                        const output = toolPart.output as { documentId?: string; kind?: string; title?: string; version?: number };

                        if (output.documentId && output.title && output.kind && DocumentArtifact) {
                            renderedParts.push(
                                <DocumentArtifact
                                    documentId={output.documentId}
                                    key={key}
                                    kind={output.kind}
                                    title={output.title}
                                    version={output.version ?? 1}
                                />,
                            );
                            break;

                            // Fall through to DefaultToolCall when DocumentArtifact not provided
                        }
                    }

                    // Special rendering for presentation tool - show presentation artifact card
                    if (part.type === "tool-createPresentation") {
                        if (toolPart.output && typeof toolPart.output === "object" && toolPart.state === "output-available") {
                            const output = toolPart.output as { presentationId?: string; slideCount?: number; styleName?: string; title?: string };

                            if (output.presentationId && output.title && PresentationArtifact) {
                                renderedParts.push(
                                    <PresentationArtifact
                                        key={key}
                                        presentationId={output.presentationId}
                                        slideCount={output.slideCount ?? 0}
                                        styleName={output.styleName}
                                        title={output.title}
                                    />,
                                );
                                break;

                                // Fall through to DefaultToolCall when PresentationArtifact not provided
                            }
                        }

                        // Show generating state while tool is executing
                        if (toolPart.state === "input-streaming" || toolPart.state === "input-available") {
                            const input = toolPart.input as { title?: string } | undefined;

                            renderedParts.push(<PresentationGenerating key={key} title={input?.title} />);
                            break;
                        }
                    }

                    // Special rendering for updateSlide tool - show a compact confirmation card
                    if (part.type === "tool-updateSlide" && toolPart.state === "output-available") {
                        const output = toolPart.output as { presentationId?: string; slideNumber?: number; title?: string } | undefined;

                        if (output?.presentationId) {
                            const { slideNumber } = output;

                            renderedParts.push(
                                <div className="my-2 flex w-full max-w-sm items-center gap-3 rounded-lg border p-3" key={key}>
                                    <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md">
                                        <Presentation className="text-muted-foreground size-5" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm font-medium">
                                            {slideNumber === undefined ? t`Updated slide` : t`Updated slide ${slideNumber}`}
                                        </div>
                                        <div className="text-muted-foreground text-xs">{output.title ?? t`Slide updated`}</div>
                                    </div>
                                </div>,
                            );
                            break;
                        }
                    }

                    // Check for a registered tool widget (weather, currency, stock, etc.)
                    if (toolWidgets && toolPart.state === "output-available" && toolPart.output) {
                        const toolName = part.type.replace("tool-", "");
                        const Widget = toolWidgets[toolName];

                        if (Widget) {
                            renderedParts.push(<Widget key={key} output={toolPart.output} />);
                            break;
                        }
                    }

                    renderedParts.push(<ResolvedToolCall key={key} part={toolPart} />);

                    if (sandboxOutputs && SandboxFiles) {
                        renderedParts.push(<SandboxFiles key={`${key}-files`} {...sandboxOutputs} />);
                    }
                } else if ((part.type as string).startsWith("data-")) {
                    // Data parts — could be custom rendered if needed
                    const dataPart = part as { data?: unknown; type: string };

                    if (dataPart.data) {
                        renderedParts.push(
                            <pre className="mb-4 overflow-x-auto rounded-lg bg-gray-100 p-3 text-xs dark:bg-gray-900" key={key}>
                                {JSON.stringify(dataPart.data, null, 2)}
                            </pre>,
                        );
                    }
                }
                // Unknown parts are silently skipped
            }
        }
    }

    // Render grouped sources at the beginning (before main content)
    if (sourceParts.length > 0) {
        renderedParts.unshift(<SourceGroup key={`${message.id}-sources`} sources={sourceParts} />);
    }

    // If no parts rendered, show placeholder for streaming or error for failed
    if (renderedParts.length === 0) {
        if (isAnimating) {
            renderedParts.push(
                <span className="animate-pulse text-gray-400" key="loading">
                    {t`Thinking...`}
                </span>,
            );
        } else if (message.status === "failed") {
            const errorMessage = message.error || t`An error occurred while generating the response.`;

            renderedParts.push(
                <div
                    className="mb-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
                    key="error"
                >
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <span>{errorMessage}</span>
                </div>,
            );
        }
    }

    // Build a source URL map for citation markers [1], [2], etc.
    const sourceUrlMap = new Map<number, string>();

    for (const [index, sourcePart] of sourceParts.entries()) {
        sourceUrlMap.set(index + 1, sourcePart.type === "source-url" ? sourcePart.url : "#");
    }

    const containerRef = useRef<HTMLDivElement>(null);

    // A document-source marker opens its chip. One delegated listener, not one
    // per marker: markers are re-created on every render.
    useEffect(() => {
        const container = containerRef.current;

        if (!container) {
            return undefined;
        }

        const openChip = (event: MouseEvent) => {
            const marker = (event.target as Element | null)?.closest<HTMLElement>("[data-citation-opens]");
            const index = marker?.dataset.citationOpens;

            if (index === undefined) {
                return;
            }

            event.preventDefault();
            container.querySelector<HTMLElement>(`[data-citation-chip="${CSS.escape(index)}"]`)?.click();
        };

        container.addEventListener("click", openChip);

        return () => {
            container.removeEventListener("click", openChip);
        };
    }, []);

    // Inject citation markers into rendered text after each render
    useEffect(() => {
        const container = containerRef.current;
        const urlMap = sourceUrlMap;

        if (!container || urlMap.size === 0) {
            return;
        }

        // Find all text nodes that contain [N] patterns
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                // Skip nodes already inside a citation marker or code blocks
                const parent = node.parentElement;

                if (!parent) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (parent.closest("[data-citation]") || parent.closest("pre") || parent.closest("code")) {
                    return NodeFilter.FILTER_REJECT;
                }

                return CITATION_MARKER_PATTERN.test(node.textContent ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            },
        });

        const textNodes: Text[] = [];

        while (walker.nextNode()) {
            textNodes.push(walker.currentNode as Text);
        }

        for (const textNode of textNodes) {
            const text = textNode.textContent ?? "";
            const parts: (Node | string)[] = [];
            let lastIndex = 0;
            const regex = /\[(\d{1,2})\]/g;

            for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
                const index = Number(match[1]);
                const url = urlMap.get(index);

                if (!url) {
                    continue;
                }

                // Text before the match
                if (match.index > lastIndex) {
                    parts.push(text.slice(lastIndex, match.index));
                }

                // A document source has no URL: its marker opens the matching chip
                // (`data-citation-chip`), which a `SourceGroup` override renders —
                // knowledge-base passages do.
                const marker = createCitationMarker(document, { index, label: resolveCitationLabel(index), url });

                parts.push(marker);
                lastIndex = match.index + match[0].length;
            }

            if (parts.length === 0) {
                continue;
            }

            // Remaining text after last match
            if (lastIndex < text.length) {
                parts.push(text.slice(lastIndex));
            }

            // Replace the text node with the parts
            const frag = document.createDocumentFragment();

            for (const part of parts) {
                frag.append(typeof part === "string" ? document.createTextNode(part) : part);
            }

            textNode.parentNode?.replaceChild(frag, textNode);
        }
    });

    return (
        <div className={cn("message-content", className)} ref={containerRef}>
            {renderedParts}
        </div>
    );
});

MessageContent.displayName = "MessageContent";

export default MessageContent;
