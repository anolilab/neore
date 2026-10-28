/**
 * IPC channel names for the local terminal. Shared by `index.ts` (the main process) and the
 * terminal window's preload. The site's preload gets none of them: a terminal is a shell as
 * the user, so only the terminal window's own page may drive one, and `index.ts` refuses every
 * other sender.
 */

export const TERMINAL_CHANNEL = {
    ack: "neore:terminal:ack",
    copy: "neore:terminal:copy",
    input: "neore:terminal:input",
    paste: "neore:terminal:paste",
    resize: "neore:terminal:resize",
    start: "neore:terminal:start",
} as const;

/** Main → terminal window. */
export const TERMINAL_EVENT = {
    data: "neore:terminal:data",
    exit: "neore:terminal:exit",
} as const;
