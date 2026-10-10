import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

export type ExtractionStatus = "completed" | "failed" | "pending" | "processing" | "unsupported";

/** How often a pending extraction is re-read. The parse itself takes milliseconds; the scheduler hop dominates. */
const POLL_MS = 1000;

const SETTLED: ReadonlySet<ExtractionStatus | undefined> = new Set<ExtractionStatus>(["completed", "failed", "unsupported"]);

/** Whether extraction has nothing left to do. */
export const isExtractionSettled = (status: ExtractionStatus | undefined): boolean => SETTLED.has(status);

/**
 * Where an uploaded document's text extraction stands (`file.getChatFileExtraction`),
 * polled until it settles — so the chip can say "reading…" while a message
 * sent now would get the raw file instead of its text. A poll rather than a
 * live query: `chatFiles` is a `.global()` table written from a scheduled
 * action, and it is read for seconds at most.
 */
export const useAttachmentExtraction = (fileId: string | undefined, enabled: boolean): ExtractionStatus | undefined => {
    const crpc = useCRPC();
    const { data } = useQuery({
        ...crpc.file.getChatFileExtraction.queryOptions(enabled && fileId ? { fileId: fileId as Id<"chatFiles"> } : skipToken, { live: false }),
        // `null` (no grant, no file) is settled too: nothing will ever change.
        refetchInterval: (query) => (query.state.data === null || isExtractionSettled(query.state.data?.status) ? false : POLL_MS),
    });

    return data?.status;
};
