import type { Doc } from "../../_generated/dataModel";

/**
 * Whether a thread's turns run on a host (a coding agent on a paired device) rather than in the cloud. The one
 * helper every other plan reads: unset means cloud (`threads.runner`, plans/acp-agent-host.md §5.1).
 */
export const isHostRunThread = (thread: Pick<Doc<"threads">, "runner"> | null | undefined): boolean => thread?.runner === "host";
