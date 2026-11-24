/**
 * The command palette's filters (plan C6): which kinds of row a palette shows, and how typed text matches a label. Pure, so the rules
 * are tested without rendering the palette.
 *
 * With no filter on, the palette shows what it always has. A filter narrows it to the kinds it names; archived narrows the thread
 * rows to archived threads and never adds rows of its own.
 */

export interface PaletteScope {
    /** Thread rows only the archived ones. */
    archived: boolean;
    /** Project rows. */
    projects: boolean;
    /** Thread rows. */
    threads: boolean;
}

export const NO_PALETTE_SCOPE: PaletteScope = { archived: false, projects: false, threads: false };

/** Whether a filter is on. With none, the palette shows its navigation, actions, thread rows, message hits and meaning hits. */
export const isPaletteScoped = (scope: PaletteScope): boolean => scope.archived || scope.projects || scope.threads;

/** Whether thread rows are shown at all: without a filter, or under the Threads or Archived filter. */
export const threadRowsVisible = (scope: PaletteScope): boolean => !isPaletteScoped(scope) || scope.threads || scope.archived;

/** Whether a thread row of this status is shown. Archived narrows the thread rows; with it on, no active thread shows. */
export const threadRowVisible = (scope: PaletteScope, status: "active" | "archived"): boolean =>
    threadRowsVisible(scope) && (!scope.archived || status === "archived");

/** Whether project rows are shown: only under the Projects filter, so the unfiltered palette keeps the rows it always had. */
export const projectRowsVisible = (scope: PaletteScope): boolean => scope.projects;

/** Navigation, thread actions and message hits are shown only without a filter. */
export const unscopedRowsVisible = (scope: PaletteScope): boolean => !isPaletteScoped(scope);

const foldText = (text: string): string => text.normalize("NFD").replaceAll(/\p{M}/gu, "").toLocaleLowerCase();

/** Whether typed text appears in a label, anywhere in it: "voice" matches "Invoice export". Case and accents are ignored. */
export const matchesWithinWords = (label: string, query: string): boolean => {
    const needle = foldText(query.trim());

    return needle === "" || foldText(label).includes(needle);
};
