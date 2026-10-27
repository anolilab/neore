import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

import { SCROLLBACK_LINES } from "./scrollback";

const ROWS = 24;
const write = (terminal: Terminal, data: string): Promise<void> =>
    new Promise((resolve) => {
        terminal.write(data, resolve);
    });

describe("scrollback", () => {
    it("stops at its limit: older lines are dropped, the newest kept", async () => {
        const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: ROWS, scrollback: SCROLLBACK_LINES });
        const lines = SCROLLBACK_LINES * 3;

        await write(terminal, Array.from({ length: lines }, (_, index) => `line ${String(index)}\r\n`).join(""));

        const { buffer } = terminal;

        expect(buffer.active.length).toBeLessThanOrEqual(ROWS + SCROLLBACK_LINES);
        expect(buffer.active.length).toBeGreaterThan(SCROLLBACK_LINES);
        // The first line is gone; the last one written is still there.
        const kept = Array.from({ length: buffer.active.length }, (_, row) => buffer.active.getLine(row)?.translateToString(true) ?? "");

        expect(kept).not.toContain("line 0");
        expect(kept).toContain(`line ${String(lines - 1)}`);
        terminal.dispose();
    });

    it("starts empty for a new shell: reset drops what was there", async () => {
        const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: ROWS, scrollback: SCROLLBACK_LINES });

        await write(terminal, Array.from({ length: 200 }, (_, index) => `old ${String(index)}\r\n`).join(""));
        terminal.reset();

        expect(terminal.buffer.active).toHaveLength(ROWS);
        expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("");
        terminal.dispose();
    });
});
