/** A page of an export query and where the next one starts (`null` when this was the last). */
interface ExportPage {
    cursor?: string | null;
}

interface TriggersPage extends ExportPage {
    triggers?: unknown[];
}

interface RunsPage extends ExportPage {
    /** The bytes the page read, whole rows included; a run's webhook body is read whole even when the export cuts it. */
    readBytes?: number;
    runs?: unknown[];
}

type ReadRuns = (triggerId: string, cursor: string | null) => Promise<RunsPage>;

/** Where a trigger's runs stop in the export, when its history did not fit. */
export interface RunsCut {
    /** When the oldest exported run started; every older run is left out. `null` when no run fitted. */
    oldestExportedStartedAt: number | null;
    runsTruncated: true;
}

/** What the export may still write and read. Reads count separately: the export action's queries share one read budget. */
interface Budget {
    readBytes: number;
    writtenBytes: number;
}

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** One trigger's runs, newest first, until one does not fit the written budget or the read budget is spent. */
const collectRuns = async (readRuns: ReadRuns, triggerId: string, left: Budget): Promise<{ isCut: boolean; runs: { startedAt: number }[] }> => {
    const runs: { startedAt: number }[] = [];
    let cursor: string | null = null;

    do {
        if (left.readBytes <= 0) {
            return { isCut: true, runs };
        }

        const page: RunsPage = await readRuns(triggerId, cursor);
        const pageRuns = (page.runs ?? []) as { startedAt: number }[];

        left.readBytes -= page.readBytes ?? 0;

        for (const run of pageRuns) {
            const size = byteLength(run);

            if (size > left.writtenBytes) {
                return { isCut: true, runs };
            }

            left.writtenBytes -= size;
            runs.push(run);
        }

        cursor = page.cursor ?? null;
    } while (cursor !== null);

    return { isCut: false, runs };
};

/**
 * Collects every trigger and as much of each one's run history as fits, newest runs first, reading each page as a query
 * inside the export action (`generateExportFile`). Settings are always exported. Runs stop at `maxBytes` written or
 * `maxReadBytes` read, whichever comes first; a page that starts under the read budget may end over it by one page and
 * the row `paginate` reads ahead. Past either, no run is read again and every later trigger is marked (`runsTruncated`)
 * whether it has runs or not: no field counts every run row, and the export must never drop runs without saying so.
 */
export const collectAllTriggers = async (
    readTriggers: (cursor: string | null) => Promise<TriggersPage>,
    readRuns: ReadRuns,
    maxBytes: number,
    maxReadBytes: number,
): Promise<{ triggers: unknown[] }> => {
    const triggers: unknown[] = [];
    const left: Budget = { readBytes: maxReadBytes, writtenBytes: maxBytes };
    let isSpent = false;
    let cursor: string | null = null;

    do {
        const page: TriggersPage = await readTriggers(cursor);
        const pageTriggers = (page.triggers ?? []) as { id: string }[];

        for (const trigger of pageTriggers) {
            // Settings are read whole and exported whole: they count against both budgets.
            const settingsBytes = byteLength(trigger);

            left.writtenBytes -= settingsBytes;
            left.readBytes -= settingsBytes;

            const collected: { isCut: boolean; runs: { startedAt: number }[] } = isSpent
                ? { isCut: true, runs: [] }
                : await collectRuns(readRuns, trigger.id, left);
            const cut: RunsCut | undefined = collected.isCut
                ? { oldestExportedStartedAt: collected.runs.at(-1)?.startedAt ?? null, runsTruncated: true }
                : undefined;

            isSpent ||= collected.isCut;
            triggers.push({ ...trigger, runs: collected.runs, ...cut });
        }

        cursor = page.cursor ?? null;
    } while (cursor !== null);

    return { triggers };
};
