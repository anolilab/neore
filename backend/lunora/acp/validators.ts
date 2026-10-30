import { v } from "lunorash/server";

import { vCapabilityReport } from "../lib/capability-report";
import { MAX_PATCH_CHARS, MAX_SUMMARY_FILES } from "./lib/constants";
import { isFolderRelativePath } from "./lib/changes";

/**
 * Host-run threads: validators shared by the schema, the ingest route and the readers
 * (plans/acp-agent-host.md §4.2, §4.6, §5.1).
 */

/**
 * Where a host turn is, as the backend knows it: `accepted` (stored, call queued), `received` (the host
 * persisted the command), `running` (the agent sent its first turn event), `ended`. Only ever moves forward;
 * a local prompt skips the first stages.
 */
export const vHostState = v.union(v.literal("accepted"), v.literal("received"), v.literal("running"), v.literal("ended"));

/**
 * Why a host stream ended. The first four are the host's own `turn_end` reasons; the rest are the backend's:
 * the reaper (`timeout`), a revoked device (`revoked`) and the Stop button (`stopped`).
 */
export const vHostEndReason = v.union(
    v.literal("finished"),
    v.literal("cancelled"),
    v.literal("failed"),
    v.literal("interrupted"),
    v.literal("timeout"),
    v.literal("revoked"),
    v.literal("stopped"),
);

export const vAcpSessionStatus = v.union(v.literal("starting"), v.literal("idle"), v.literal("busy"), v.literal("offline"), v.literal("ended"));

/**
 * One event of a host turn, as the desktop posts it. `text` and `reasoning` become the chunk's text; every
 * other kind is kept on its chunk as `event`, so each event takes exactly one `(turnId, seq)` slot.
 * Spelled out in one union (not from shared consts): codegen reads a column's type from the inline expression.
 */
export const vHostEvent = v.union(
    v.object({
        agentKey: v.string().max(128),
        agentLabel: v.string().max(200),
        // What the agent reported at the handshake, mapped by the desktop into the capability report.
        capabilities: v.optional(vCapabilityReport),
        folderId: v.string().max(128),
        folderLabel: v.string().max(200),
        kind: v.literal("session_open"),
        nativeSessionId: v.optional(v.string().max(256)),
    }),
    // An import (S6) of an agent's saved session: `import_open` finds or makes the thread, each `import_turn` is one
    // prompt and its reply, `import_end` closes the transcript. Posted as session-level (`import_open`) or turn-level posts.
    v.object({
        agentKey: v.string().max(128),
        agentLabel: v.string().max(200),
        capabilities: v.optional(vCapabilityReport),
        folderId: v.string().max(128),
        folderLabel: v.string().max(200),
        kind: v.literal("import_open"),
        nativeSessionId: v.string().max(256),
        title: v.optional(v.string().max(200)),
    }),
    v.object({
        kind: v.literal("import_turn"),
        reasoning: v.optional(v.string().max(65_536)),
        text: v.string().max(65_536),
        user: v.string().max(100_000),
    }),
    v.object({ kind: v.literal("import_end") }),
    v.object({ kind: v.literal("turn_start"), text: v.string().max(100_000) }),
    v.object({ kind: v.literal("text"), text: v.string().max(65_536) }),
    v.object({ kind: v.literal("reasoning"), text: v.string().max(65_536) }),
    v.object({
        id: v.string().max(128),
        kind: v.literal("tool"),
        status: v.union(
            v.literal("pending"),
            v.literal("in_progress"),
            v.literal("completed"),
            v.literal("failed"),
            v.literal("cancelled"),
            v.literal("declined"),
        ),
        title: v.string().max(500),
        toolKind: v.string().max(64),
    }),
    // `command` and `target` may carry paths and file contents' names: §4.4 shows the request in full to its owner.
    v.object({
        command: v.optional(v.string().max(10_000)),
        // False when the command, target or details were cut: the web then offers a decline only.
        complete: v.optional(v.boolean()),
        folder: v.optional(v.string().max(500)),
        kind: v.literal("permission_request"),
        options: v
            .array(v.object({ kind: v.string().max(64), name: v.string().max(200), optionId: v.string().max(128) }))
            .check((options) => options.length <= 16, { message: "Too many options" }),
        requestId: v.string().max(128),
        target: v.optional(v.string().max(2000)),
        tool: v.string().max(500),
    }),
    v.object({
        kind: v.literal("permission_resolved"),
        outcome: v.union(v.literal("allowed"), v.literal("declined"), v.literal("cancelled")),
        requestId: v.string().max(128),
    }),
    // One of the agent's own children (plans/acp-agent-host.md §4.7). `spawnId` is the tool call that started the child
    // and keys its transcript; the host posts these only when the agent reports its children.
    v.object({
        field: v.union(v.literal("text"), v.literal("reasoning")),
        kind: v.literal("child_text"),
        spawnId: v.string().max(128),
        text: v.string().max(65_536),
    }),
    v.object({
        id: v.string().max(128),
        kind: v.literal("child_tool"),
        spawnId: v.string().max(128),
        status: v.union(
            v.literal("pending"),
            v.literal("in_progress"),
            v.literal("completed"),
            v.literal("failed"),
            v.literal("cancelled"),
            v.literal("declined"),
        ),
        title: v.string().max(500),
        toolKind: v.string().max(64),
    }),
    v.object({
        kind: v.literal("child_end"),
        spawnId: v.string().max(128),
        status: v.union(v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
        // Set only for a child that streamed no text: its completion message, whole.
        text: v.optional(v.string().max(65_536)),
    }),
    // A file the reply refers to, in the folder the agent was approved for. The desktop reads it (Rust, confined to
    // the folder), uploads it over the device upload route and names it here by `uploadId`; with no `uploadId` it was
    // over the size cap and only its name and size are kept. `fileId` and `storageKey` are the BACKEND's: the ingest
    // finalizes the upload and sets them, and drops any a device sent, so a device cannot name stored bytes.
    v.object({
        contentType: v.optional(v.string().max(100)),
        fileId: v.optional(v.string().max(64)),
        kind: v.literal("media"),
        name: v.string().max(255),
        reference: v.string().max(1024),
        size: v.number().check((size) => Number.isSafeInteger(size) && size >= 0, { message: "Invalid size" }),
        storageKey: v.optional(v.string().max(512)),
        uploadId: v.optional(v.string().max(64)),
    }),
    v.object({
        error: v.optional(v.string().max(1000)),
        kind: v.literal("turn_end"),
        reason: v.union(v.literal("finished"), v.literal("cancelled"), v.literal("failed"), v.literal("interrupted")),
        // What the turn's own tool calls wrote (plans/acp-agent-host.md §4.9). Paths are relative to the approved folder.
        summary: v.optional(
            v.object({
                files: v
                    .array(
                        v.object({
                            added: v.number().check((count) => Number.isSafeInteger(count) && count >= 0, { message: "Counts are non-negative integers" }),
                            path: v.string().min(1).max(1024).check(isFolderRelativePath, { message: "A path inside the folder, relative to it" }),
                            removed: v.number().check((count) => Number.isSafeInteger(count) && count >= 0, { message: "Counts are non-negative integers" }),
                        }),
                    )
                    .check((files) => files.length <= MAX_SUMMARY_FILES, { message: "Too many files" }),
                // The unified diff, or `{ tooLarge: true }` when the host could not keep it.
                patch: v.optional(v.union(v.string().max(MAX_PATCH_CHARS), v.object({ tooLarge: v.literal(true) }))),
            }),
        ),
    }),
);

/**
 * A permission request a host turn is waiting on, as the web and the phone show it: what the agent asked to do and
 * the options it offered. Only allow-once and reject-once options are ever listed (`acp/remote.ts`).
 */
export const vPendingPermission = v.object({
    command: v.optional(v.string().max(10_000)),
    folder: v.optional(v.string().max(500)),
    /** True when the request was cut, so the person is not offered "allow" for what they cannot read whole. */
    incomplete: v.optional(v.boolean()),
    options: v.array(v.object({ kind: v.string().max(64), name: v.string().max(200), optionId: v.string().max(128) })),
    requestId: v.string().max(128),
    target: v.optional(v.string().max(2000)),
    tool: v.string().max(500),
});
