/**
 * Which tools may run a second time after a worker died inside them (`mark-tool-runs.ts`, `interrupted-run.ts`). A tool
 * that only reads leaves nothing behind that a second call could double, so a run that died inside one is resumed and
 * the call is made again. Anything else may have paid for or changed something, and is never repeated.
 *
 * Unsafe by default: a built-in counts only when it is named here, and a server's tool only when the server says it
 * reads (`readOnlyHint: true`) and does not also say it destroys or reaches the open world (the hints the quick check
 * refuses on, `low-risk-approval.ts`). Those hints are the server's word, as they are for running a tool unasked
 * (`defaultToolPermission`). A device tool never counts.
 */
import type { ToolDescriptor } from "./tool-permissions";

/** Built-ins that only read: a second call returns an answer and changes nothing. A new built-in is not listed until it is checked. */
export const BUILTIN_TOOLS_SAFE_TO_REPEAT: ReadonlySet<string> = new Set([
    "academicSearch",
    "codeSearch",
    "dateTime",
    "githubSearch",
    "knowledgeSearch",
    "retrieve",
    "searchMemory",
    "webSearch",
]);

/** Whether a tool may be called again by a resume. `descriptor` absent: a built-in, named by `runtimeName`. */
export const isSafeToRepeat = (runtimeName: string, descriptor: Pick<ToolDescriptor, "annotations" | "source"> | undefined): boolean => {
    if (descriptor === undefined || descriptor.source === "builtin") {
        return BUILTIN_TOOLS_SAFE_TO_REPEAT.has(runtimeName);
    }

    if (descriptor.source === "device") {
        return false;
    }

    const hints = descriptor.annotations;

    return hints?.readOnlyHint === true && hints.destructiveHint !== true && hints.openWorldHint !== true;
};
