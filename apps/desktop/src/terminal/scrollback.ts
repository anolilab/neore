/**
 * Scrollback is the terminal view's own buffer and lives in the window's memory only: nothing in the
 * main process or the host keeps output (`session.ts` holds counters, `host.ts` one batch). A reopened
 * terminal is a new shell with an empty buffer, and closing the window frees this one with the page.
 */

/** Lines kept above the visible screen. The view drops the oldest line beyond this. */
export const SCROLLBACK_LINES = 5000;
