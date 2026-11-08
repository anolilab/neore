/** A page of an export query and where the next one starts (`null` when this was the last). */
interface ExportPage {
    cursor?: string | null;
}

interface TriggersPage extends ExportPage {
    triggers?: unknown[];
}

interface RunsPage extends ExportPage {
    runs?: unknown[];
}

/** `onlyOne` asks for a single run: enough to tell whether a trigger has any. */
type ReadRuns = (triggerId: string, cursor: string | null, onlyOne?: boolean) => Promise<RunsPage>;

/** Where a trigger's runs stop in the export, when its history did not fit. */
export interface RunsCut {
    /** When the oldest exported run started; every older run is left out. `null` when no run fitted. */
    oldestExportedStartedAt: number | null;
    runsTruncated: true;
}

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** One trigger's runs, newest first, until one does not fit in `budget` bytes. */
const collectRuns = async (
    readRuns: ReadRuns,
    triggerId: string,
    budget: number,
): Promise<{ bytes: number; isCut: boolean; runs: { startedAt: number }[] }> => {
    const runs: { startedAt: number }[] = [];
    let bytes = 0;
    let cursor: string | null = null;

    do {
        const page: RunsPage = await readRuns(triggerId, cursor);
        const pageRuns = (page.runs ?? []) as { startedAt: number }[];

        for (const run of pageRuns) {
            const size = byteLength(run);

            if (bytes + size > budget) {
                return { bytes, isCut: true, runs };
            }

            bytes += size;
            runs.push(run);
        }

        cursor = page.cursor ?? null;
    } while (cursor !== null);

    return { bytes, isCut: false, runs };
};

/** A trigger past the budget: no run is exported, and it is marked as cut only if it has runs to leave out. */
const hasRuns = async (readRuns: ReadRuns, triggerId: string): Promise<{ bytes: number; isCut: boolean; runs: { startedAt: number }[] }> => {
    const page = await readRuns(triggerId, null, true);

    return { bytes: 0, isCut: (page.runs ?? []).length > 0, runs: [] };
};

/**
 * Collects every trigger and as much of each one's run history as fits in `maxBytes`, newest runs first, reading each page
 * as a query inside the export action (`generateExportFile`). Settings are always exported. Once a run does not fit, no
 * further run page is read and each trigger whose runs stop early is marked (`runsTruncated`), so the export never fails
 * for a long history and never drops runs without saying so.
 */
export const collectAllTriggers = async (
    readTriggers: (cursor: string | null) => Promise<TriggersPage>,
    readRuns: ReadRuns,
    maxBytes: number,
): Promise<{ triggers: unknown[] }> => {
    const triggers: unknown[] = [];
    let bytes = 0;
    let isSpent = false;
    let cursor: string | null = null;

    do {
        const page: TriggersPage = await readTriggers(cursor);
        const pageTriggers = (page.triggers ?? []) as { id: string }[];

        for (const trigger of pageTriggers) {
            bytes += byteLength(trigger);

            // Once the budget is spent, later triggers export their settings; one read says whether any run was left out.
            const collected: { bytes: number; isCut: boolean; runs: { startedAt: number }[] } = isSpent
                ? await hasRuns(readRuns, trigger.id)
                : await collectRuns(readRuns, trigger.id, maxBytes - bytes);
            const cut: RunsCut | undefined = collected.isCut
                ? { oldestExportedStartedAt: collected.runs.at(-1)?.startedAt ?? null, runsTruncated: true }
                : undefined;

            bytes += collected.bytes;
            isSpent ||= collected.isCut;
            triggers.push({ ...trigger, runs: collected.runs, ...cut });
        }

        cursor = page.cursor ?? null;
    } while (cursor !== null);

    return { triggers };
};
