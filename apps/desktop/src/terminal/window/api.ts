/** What the terminal window's preload exposes as `window.neoreTerminal`. */
export interface TerminalExit {
    crashed: boolean;
    exitCode: number | null;
    /** `user@address` when the shell is on a server, so the page can say the connection ended. */
    host?: string;
}

export interface TerminalWindowApi {
    /** Tells the main process that `chars` characters of output are on screen, so it can resume a paused shell. */
    ack: (chars: number) => Promise<void>;
    copy: (text: string) => Promise<void>;
    input: (data: string) => Promise<void>;
    onData: (handler: (data: string) => void) => () => void;
    onExit: (handler: (exit: TerminalExit) => void) => () => void;
    paste: () => Promise<string>;
    resize: (cols: number, rows: number) => Promise<void>;
    start: (cols: number, rows: number) => Promise<{ cwd: string; shell: string }>;
}

declare global {
    // The preload exposes this on the page's global object; the terminal page reads it from there.
    // eslint-disable-next-line vars-on-top -- declare global takes var, not let or const
    var neoreTerminal: TerminalWindowApi;
}
