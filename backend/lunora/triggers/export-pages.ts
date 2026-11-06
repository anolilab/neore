import { LunoraError } from "lunorash/server";

/** One page of `collectTriggersForExport`: its triggers, and where the next page starts (`null` when this was the last). */
interface TriggersPage {
    cursor?: string | null;
    triggers?: unknown[];
}

/**
 * Collects every page of a user's triggers, running each page as a query inside the export action (`generateExportFile`).
 * A result without a cursor ends the walk. Past `maxBytes` the export is refused, as the ACP history is.
 */
export const collectAllTriggers = async (readPage: (cursor: string | null) => Promise<unknown>, maxBytes: number): Promise<{ triggers: unknown[] }> => {
    const triggers: unknown[] = [];
    let cursor: string | null = null;
    let bytes = 0;

    for (;;) {
        const result = (await readPage(cursor)) as TriggersPage;
        const page = result.triggers ?? [];

        bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;

        if (bytes > maxBytes) {
            throw new LunoraError("PAYLOAD_TOO_LARGE", "The trigger history is larger than the export limit");
        }

        triggers.push(...page);

        if (!result.cursor) {
            return { triggers };
        }

        cursor = result.cursor;
    }
};
