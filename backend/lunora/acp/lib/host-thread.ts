import { LunoraError } from "lunorash/server";

import type { Doc } from "../../_generated/dataModel";

/**
 * Whether a thread's turns run on a host (a coding agent on a paired device) rather than in the cloud. The one
 * helper every other plan reads: unset means cloud (`threads.runner`, plans/acp-agent-host.md §5.1).
 */
export const isHostRunThread = (thread: Pick<Doc<"threads">, "runner"> | null | undefined): boolean => thread?.runner === "host";

/**
 * A host thread stays between its owner and their computer in v1 (plans/acp-agent-host.md §5.1): a grant, a
 * public copy or a group would let someone else's request reach a device that never agreed to answer it.
 * Throws for the procedures that would widen who can reach the thread.
 */
export const refuseHostThread = (thread: Pick<Doc<"threads">, "runner"> | null | undefined, what: string): void => {
    if (isHostRunThread(thread)) {
        throw new LunoraError("BAD_REQUEST", `A coding-agent thread runs on your computer and cannot be ${what}.`);
    }
};
