/**
 * The LOCAL terminal window's page: an xterm.js view over one shell. It reaches the main process only
 * through `window.neoreTerminal`. Bundled as a classic script (`terminal.js`).
 *
 * Shell output is written to the view as text and never rendered as HTML.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { SCROLLBACK_LINES } from "../scrollback";
import { MAX_INPUT_CHARS } from "../validate";
import type { TerminalExit } from "./api";

const $ = (id: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(`#${id}`);

    if (element === null) {
        throw new Error(`missing #${id}`);
    }

    return element;
};

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- a browser page, not Node
const isMac = navigator.userAgent.includes("Mac");
const api = globalThis.neoreTerminal;

/** A command the page does not wait on: its failure (the shell just ended, say) changes nothing the user can act on. */
const quietly = async (work: Promise<unknown>): Promise<void> => {
    try {
        await work;
    } catch {
        // Nothing to do.
    }
};

const createView = (): { fit: FitAddon; term: Terminal } => {
    const term = new Terminal({
        allowProposedApi: false,
        cursorBlink: true,
        fontFamily: "ui-monospace, \"SF Mono\", Menlo, Consolas, \"DejaVu Sans Mono\", monospace",
        fontSize: 13,
        scrollback: SCROLLBACK_LINES,
        theme: { background: "#1e1e1e", foreground: "#f2f2f2" },
    });
    const fit = new FitAddon();

    term.loadAddon(fit);
    term.open($("terminal"));
    fit.fit();

    return { fit, term };
};

const { fit, term } = createView();
// Page-wide state, kept on one object so the functions below assign properties rather than module bindings.
// `generation` names the shell the page is on, so a reply that outlives its shell can be told apart; `ended` is
// set when the current one has already exited, which can happen before its start request is answered.
const state: { ended: boolean; generation: number; notice?: ReturnType<typeof setTimeout>; running: boolean; starting: boolean } = {
    ended: false,
    generation: 0,
    running: false,
    starting: false,
};

const NOTICE_MS = 5000;
const showNotice = (text: string): void => {
    const notice = $("notice");

    notice.textContent = text;
    notice.hidden = false;
    clearTimeout(state.notice);
    state.notice = setTimeout(() => {
        notice.hidden = true;
    }, NOTICE_MS);
};

const pasteFromClipboard = async (): Promise<void> => {
    const { generation } = state;
    const text = await api.paste();

    // The shell the user pasted into is gone; its text does not belong in the next one.
    if (generation !== state.generation) {
        return;
    }

    if (text.length > MAX_INPUT_CHARS) {
        // The main process refuses a write this large; saying so beats a paste that does nothing.
        showNotice("The text on the clipboard is over 1 MiB, so it was not pasted.");
    } else if (text.length > 0) {
        term.paste(text);
    }
};

/** Copy with the selection (⌘C on macOS; Ctrl+Shift+C elsewhere, where Ctrl+C is the interrupt); paste likewise. */
const handleKey = (event: KeyboardEvent): boolean => {
    if (event.type !== "keydown") {
        return true;
    }

    const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey;
    const key = event.key.toLowerCase();

    if (modifier && key === "c" && term.hasSelection()) {
        // xterm skips the key but does not cancel it, so the menu's own Copy would run as well.
        event.preventDefault();
        quietly(api.copy(term.getSelection()));

        return false;
    }

    if (modifier && key === "v") {
        event.preventDefault();
        quietly(pasteFromClipboard());

        return false;
    }

    return true;
};

const showEnded = (text: string): void => {
    $("ended-text").textContent = text;
    $("ended").hidden = false;
    $("restart").focus();
};

const start = async (): Promise<void> => {
    // A second request while one is pending would be refused by the main process and report a failure for a shell that started.
    if (state.starting) {
        return;
    }

    state.starting = true;
    state.generation += 1;
    state.ended = false;
    $("ended").hidden = true;
    // A new shell starts on an empty screen and an empty buffer.
    term.reset();
    fit.fit();

    try {
        await api.start(term.cols, term.rows);

        if (!state.ended) {
            state.running = true;
            // The window may have been resized while the shell was starting.
            await quietly(api.resize(term.cols, term.rows));
            term.focus();
        }
    } catch (error) {
        showEnded(`The shell could not start: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        state.starting = false;
    }
};

term.attachCustomKeyEventHandler(handleKey);
term.onData((data) => {
    if (state.running) {
        quietly(api.input(data));
    }
});
term.onResize(({ cols, rows }) => {
    if (state.running) {
        quietly(api.resize(cols, rows));
    }
});

api.onData((data) => {
    const { generation } = state;

    // The shell is told the text is on screen only once the view has taken it, so a flood is paused at the source.
    // An acknowledgement that outlives its shell would count against the next one.
    term.write(data, () => {
        if (generation === state.generation) {
            quietly(api.ack(data.length));
        }
    });
});

api.onExit((exit: TerminalExit) => {
    state.ended = true;
    state.running = false;
    showEnded(exit.crashed ? "The shell stopped unexpectedly." : `The shell exited (code ${String(exit.exitCode)}).`);
});

$("restart").addEventListener("click", () => start());

window.addEventListener("resize", () => fit.fit());

// eslint-disable-next-line unicorn/prefer-top-level-await -- the page builds as an IIFE, where top-level await does not parse
start();
