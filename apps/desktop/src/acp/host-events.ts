/** What an agent session reports about its turns, and what the backend is told of them (`ingest.ts`). */
import type { CapabilityReport } from "@neore/ai/capabilities";

import type { ChildEvent } from "./children";
import type { StopReason } from "./types";

export interface PermissionOption {
    kind: string;
    name: string;
    optionId: string;
}

export interface PermissionRequestEvent {
    command?: string;
    /** False when anything the person decides on is missing: the details were cut, here or by the core. A remote "allow" is never offered for it. */
    complete?: boolean;
    folder?: string;
    kind: "permission_request";
    options: PermissionOption[];
    requestId: string;
    target?: string;
    tool: string;
}

export type PermissionOutcomeKind = "allowed" | "cancelled" | "declined";

/** A file the reply refers to (`media.ts`): uploaded and named by `uploadId`, or, over the size cap, only named. */
export interface MediaEvent {
    contentType: string;
    kind: "media";
    name: string;
    reference: string;
    size: number;
    uploadId?: string;
}

/** One file a turn wrote: its path inside the approved folder (never absolute) and its line counts. */
export interface ChangedFile {
    added: number;
    path: string;
    removed: number;
}

/** What a turn changed (plan §4.9). `patch` is the frozen unified diff, or `{ tooLarge: true }` when it did not fit. */
export interface TurnSummary {
    files: ChangedFile[];
    patch?: string | { tooLarge: true };
}

export interface TurnEndEvent {
    error?: string;
    kind: "turn_end";
    reason: "cancelled" | "failed" | "finished" | "interrupted";
    summary?: TurnSummary;
}

export type HostEvent
    = MediaEvent | PermissionRequestEvent | (HostSessionInfo & { kind: "session_open" }) | TurnEndEvent | { kind: "child_end"; spawnId: string; status: "cancelled" | "completed" | "failed"; text?: string } | { id: string; kind: "child_tool"; spawnId: string; status: string; title: string; toolKind: string } | { field: "reasoning" | "text"; kind: "child_text"; spawnId: string; text: string } | { id: string; kind: "tool"; status: string; title: string; toolKind: string } | { kind: "permission_resolved"; outcome: PermissionOutcomeKind; requestId: string } | { kind: "reasoning" | "text" | "turn_start"; text: string };

export interface HostSessionInfo {
    agentKey: string;
    agentLabel: string;
    /** What the agent advertised at the handshake (`capabilities.ts`). */
    capabilities?: CapabilityReport;
    folderId: string;
    folderLabel: string;
    /** The agent's own id for the session, so an import finds it and a later reattach can use it. */
    nativeSessionId?: string;
    /** For a session the backend started with a saved session id (harness switch S4): whether the agent loaded it, and why not. */
    reattach?: { loaded: boolean; reason?: "load_failed" | "load_unsupported" };
}

/** What an `AgentSession` tells whoever persists its turns. Every method returns at once and never throws. */
export interface SessionObserver {
    /** One of the agent's own children said or did something (`children.ts`): `spawnId` is the tool call that started it. */
    child?: (sessionId: string, turnId: string, spawnId: string, event: ChildEvent) => void;
    permissionRequested: (sessionId: string, turnId: string, request: PermissionRequestEvent) => void;
    permissionResolved: (sessionId: string, turnId: string, requestId: string, outcome: PermissionOutcomeKind) => void;
    sessionEnded: (sessionId: string) => void;
    /** `threadId` is known when the backend started the session (`acp_start`); otherwise opening it makes the thread. */
    sessionOpened: (sessionId: string, info: HostSessionInfo, threadId?: string) => void;
    text: (sessionId: string, turnId: string, delta: string) => void;
    thought: (sessionId: string, turnId: string, delta: string) => void;
    tool: (sessionId: string, turnId: string, tool: { id: string; kind: string; status: string; title: string }) => void;
    turnEnded: (sessionId: string, turnId: string, reason: StopReason | "failed", error?: string, summary?: TurnSummary) => void;
    /** A prompt the backend queued (`acp_send`) is in this computer's hands, running or waiting its turn: the turn is `received`. */
    turnReceived?: (sessionId: string, turnId: string, user: string) => void;
    turnStarted: (sessionId: string, turnId: string, user: string) => void;
}

// The backend's limits on what one event may carry (`backend/lunora/acp/validators.ts`). A post with one field past
// them is refused whole, so the host cuts to them first.
const MAX_PROMPT_CHARS = 100_000;
const MAX_OPTIONS = 16;
const MAX_COMMAND_CHARS = 10_000;
const MAX_TARGET_CHARS = 2000;

/** A session's labels, cut to what the backend takes. */
export const capSessionInfo = (info: HostSessionInfo): HostSessionInfo => {
    return {
        agentKey: info.agentKey.slice(0, 128),
        agentLabel: info.agentLabel.slice(0, 200),
        folderId: info.folderId.slice(0, 128),
        folderLabel: info.folderLabel.slice(0, 200),
        ...info.capabilities !== undefined && { capabilities: info.capabilities },
        ...info.nativeSessionId !== undefined && info.nativeSessionId !== "" && { nativeSessionId: info.nativeSessionId.slice(0, 256) },
        ...info.reattach !== undefined && { reattach: { loaded: info.reattach.loaded, ...info.reattach.reason !== undefined && { reason: info.reattach.reason } } },
    };
};

/** A permission request, cut to what the backend takes. `command` and `target` may carry paths; the user chose to show them (plan §4.4). */
export const capPermissionRequest = (request: PermissionRequestEvent): PermissionRequestEvent => {
    const cut = (request.command?.length ?? 0) > MAX_COMMAND_CHARS || (request.target?.length ?? 0) > MAX_TARGET_CHARS;

    return {
        complete: request.complete !== false && !cut,
        kind: "permission_request",
        options: request.options.slice(0, MAX_OPTIONS).map((option) => {
            return { kind: option.kind.slice(0, 64), name: option.name.slice(0, 200), optionId: option.optionId.slice(0, 128) };
        }),
        requestId: capRequestId(request.requestId),
        tool: request.tool.slice(0, 500),
        ...request.folder !== undefined && { folder: request.folder.slice(0, 500) },
        ...request.command !== undefined && { command: request.command.slice(0, MAX_COMMAND_CHARS) },
        ...request.target !== undefined && { target: request.target.slice(0, MAX_TARGET_CHARS) },
    };
};

export const capRequestId = (requestId: string): string => requestId.slice(0, 128);

/**
 * What an event adds to the body of a post, in UTF-8 bytes: the payload is JSON inside a JSON string, so quotes
 * and backslashes are escaped twice, and a CJK character is three bytes. The backend caps the body, not the characters.
 */
export const wireBytes = (event: object): number => Buffer.byteLength(JSON.stringify(JSON.stringify(event)));

/** The largest single event a batch may start with; a batch's first event is always taken, so it must fit alone. */
const MAX_EVENT_BYTES = 150_000;

/** `text` cut to `limit` characters and, for any script, until the event `make` builds from it fits in one post. */
const cutToWire = (text: string, limit: number, make: (cut: string) => object): string => {
    let cut = text.slice(0, limit);

    while (wireBytes(make(cut)) > MAX_EVENT_BYTES) {
        cut = cut.slice(0, Math.floor(cut.length * 0.8));
    }

    return cut;
};

const LIMIT_STOPS: ReadonlySet<StopReason | "failed"> = new Set(["failed", "max_tokens", "max_turn_requests"]);

/** The user's prompt as the first event of a turn: within the backend's character cap and, for any script, within one post. */
export const capPrompt = (text: string): string =>
    cutToWire(text, MAX_PROMPT_CHARS, (cut) => {
        return { kind: "turn_start", text: cut };
    });

/** What the backend takes of a child's completion text; the child's streamed text is kept whole, in pieces. */
const MAX_CHILD_END_CHARS = 30_000;
/** The longest piece of a child's streamed text in one event, as for the agent's own (`turn-channel.ts`). */
const MAX_CHILD_PIECE = 16_000;

/** A child's event as the events the backend takes: streamed text in pieces, every field cut to its limit. */
export const childHostEvents = (spawnId: string, event: ChildEvent): HostEvent[] => {
    const id = spawnId.slice(0, 128);

    if (event.kind === "text" || event.kind === "reasoning") {
        const pieces: HostEvent[] = [];

        for (let start = 0; start < event.text.length; start += MAX_CHILD_PIECE) {
            pieces.push({ field: event.kind, kind: "child_text", spawnId: id, text: event.text.slice(start, start + MAX_CHILD_PIECE) });
        }

        return pieces;
    }

    if (event.kind === "tool") {
        return [
            {
                id: event.id.slice(0, 128),
                kind: "child_tool",
                spawnId: id,
                status: event.status,
                title: event.title.slice(0, 500),
                toolKind: event.toolKind.slice(0, 64),
            },
        ];
    }

    const text
        = event.text === undefined
            ? undefined
            : cutToWire(event.text, MAX_CHILD_END_CHARS, (cut) => {
                return { kind: "child_end", spawnId: id, status: event.status, text: cut };
            });

    return [{ kind: "child_end", spawnId: id, status: event.status, ...text !== undefined && text !== "" && { text } }];
};

/** The files a turn may list, and the paths in them (`backend/lunora/acp/validators.ts`). */
export const MAX_SUMMARY_FILES = 200;
export const MAX_SUMMARY_PATH_CHARS = 1024;
/** The backend's cap on a patch, in characters; the host keeps a smaller one (`changes.ts`). */
const MAX_BACKEND_PATCH_CHARS = 256 * 1024;

const DRIVE_PATH = /^[A-Za-z]:/u;
const SEPARATOR = /[/\\]/u;

/**
 * A path the backend accepts in a summary: `isFolderRelativePath` and the length bounds of `backend/lunora/acp`. One
 * entry the backend refuses refuses the whole post, so it is checked here, on the text that is actually sent.
 */
export const isSummaryPath = (value: string): boolean =>
    value.length > 0
    && value.length <= MAX_SUMMARY_PATH_CHARS
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !DRIVE_PATH.test(value)
    && [...value].every((char) => (char.codePointAt(0) ?? 0) > 0x1F)
    && !value.split(SEPARATOR).includes("..");

const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** Only what the backend takes: an entry it would refuse is left out, so it cannot cost the turn its end. */
const sendableSummary = (summary: TurnSummary): TurnSummary => {
    const files = summary.files.filter((file) => isSummaryPath(file.path) && isCount(file.added) && isCount(file.removed)).slice(0, MAX_SUMMARY_FILES);
    const { patch } = summary;
    const keep = typeof patch !== "string" || patch.length <= MAX_BACKEND_PATCH_CHARS;

    return { files, ...patch !== undefined && { patch: keep ? patch : { tooLarge: true as const } } };
};

/**
 * The end of a turn with its summary, held to what one post can carry. The backend allows a 256 KiB patch, but a post
 * is capped at 256 KiB whole and this event must fit one post alone, escaped twice, so the patch gives way first
 * (`{ tooLarge: true }`, the file list and counts stay) and only then the tail of the file list.
 */
export const turnEndEvent = (reason: TurnEndEvent["reason"], error: string | undefined, summary: TurnSummary | undefined): TurnEndEvent => {
    const base: TurnEndEvent = { kind: "turn_end", reason, ...error !== undefined && { error: error.slice(0, 1000) } };

    const sendable = summary === undefined ? undefined : sendableSummary(summary);

    if (sendable === undefined || sendable.files.length === 0) {
        return base;
    }

    let { files, patch } = sendable;
    const fits = (): boolean => wireBytes({ ...base, summary: { files, ...patch !== undefined && { patch } } }) <= MAX_EVENT_BYTES;

    if (typeof patch === "string" && !fits()) {
        patch = { tooLarge: true };
    }

    while (!fits() && files.length > 1) {
        files = files.slice(0, Math.ceil(files.length / 2));
    }

    return { ...base, summary: { files, ...patch !== undefined && { patch } } };
};

/** How a stop reason is told to the backend. */
export const endReasonOf = (reason: StopReason | "failed"): "cancelled" | "failed" | "finished" => {
    if (reason === "cancelled") {
        return "cancelled";
    }

    // An agent that stopped at a limit did not finish the turn: it is told as a failure until a usage-limit outcome exists.
    return LIMIT_STOPS.has(reason) ? "failed" : "finished";
};

/** What one post came to: the backend's next `seq`, a request to resend from there, a refusal, or a reason to try again. */
export type PostResult
    = | { kind: "gap"; next: number }
        | { ended: boolean; existing?: boolean; kind: "ok"; next: number; threadId?: string }
        | { kind: "refused" }
        | { kind: "retry" };

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** Exponential from one second to thirty, with jitter (half to full), so hosts that failed together do not retry together. */
export const jitteredBackoff = (attempts: number, random: () => number): number =>
    Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(attempts, 10)) * (0.5 + random() * 0.5);
