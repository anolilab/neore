export interface TextPart {
    /** Set by the backend; `neore.pageContext` marks an attached web page (see `utils/page-context.ts`). */
    providerMetadata?: { [provider: string]: unknown; neore?: { pageContext?: unknown } };
    text: string;
    type: "text";
}

export interface ReasoningPart {
    text: string;
    type: "reasoning";
}

export interface ImagePart {
    filename?: string;
    image: string;
    nsfwStatus?: string;
    prompt?: string;
    type: "image";
}

export interface FilePart {
    data?: string;
    filename?: string;
    mediaType?: string;
    nsfwStatus?: string;
    type: "file";
    url?: string;
}

export interface ToolPart {
    /** Present once the tool call went through human approval (`needsApproval`). */
    approval?: { approved?: boolean; id: string; reason?: string };
    /** `neore` carries an MCP call's real server and tool names, when the backend labelled it. */
    callProviderMetadata?: { neore?: { mcpServerName?: unknown; mcpToolName?: unknown } };
    errorText?: string;
    input?: unknown;
    output?: unknown;
    state?: "approval-requested" | "approval-responded" | "input-available" | "input-streaming" | "output-available" | "output-denied" | "output-error";
    toolCallId: string;
    /** "tool-{toolName}" */
    type: string;
}

export interface SourceUrlPart {
    sourceId: string;
    title?: string;
    type: "source-url";
    url: string;
}

export interface SourceDocumentPart {
    filename?: string;
    mediaType?: string;
    sourceId: string;
    title?: string;
    type: "source-document";
}

export type MessagePart =
    FilePart | ImagePart | ReasoningPart | SourceDocumentPart | SourceUrlPart | TextPart | ToolPart | { [key: string]: unknown; type: string };

export interface MessageUsage {
    completionTokens: number;
    durationMs?: number;
    promptTokens: number;
    totalTokens: number;
    /** Time-to-first-token in ms */
    ttftMs?: number;
}

export interface ChatMessage {
    _creationTime?: number;
    error?: string;
    id: string;
    /** Free-form per-message metadata; `prompt` and `errorType` are the keys the UI reads. */
    metadata?: { [key: string]: unknown; errorType?: string; prompt?: string };
    model?: string;
    parts: MessagePart[];
    role: "assistant" | "system" | "tool" | "user";
    /** Group chat: the participant that wrote this reply, shown as a label above it. */
    speakerName?: string;
    /** Group chat: that participant's skill id. */
    speakerSkillId?: string;
    status?: "failed" | "pending" | "streaming" | "success" | string;
    text?: string;
    usage?: MessageUsage;
}
