/** The runner against the real file system (symlinks, `/var` → `/private/var` on macOS), with the watcher's events fired by hand. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HookApprovals } from "./approvals";
import { nodeHookFs } from "./fs";
import { DEBOUNCE_MS, HookRunner } from "./runner";

let directory: string;
let folder: string;
let outside: string;
let emit: (eventType: string, filename: string | null) => void;
let sent: string[];
let runner: HookRunner;

beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "neore-hooks-real-"));
    folder = path.join(directory, "project");
    outside = path.join(directory, "outside");
    mkdirSync(path.join(folder, ".neore"), { recursive: true });
    mkdirSync(path.join(folder, "src"));
    mkdirSync(outside);
    writeFileSync(path.join(folder, ".neore", "hooks.json"), JSON.stringify({ hooks: [{ glob: "**", id: "all", name: "All", on: "saved", prompt: "Look." }], version: 1 }));
    writeFileSync(path.join(folder, "src", "a.ts"), "a");
    writeFileSync(path.join(outside, "secret.ts"), "s");
    symlinkSync(path.join(outside, "secret.ts"), path.join(folder, "src", "link.ts"));
    symlinkSync(outside, path.join(folder, "escape"));
    sent = [];
    // The folder is given by a path through a link, as /var is on macOS: containment is by real path.
    const alias = path.join(directory, "alias");

    symlinkSync(folder, alias);
    runner = new HookRunner({
        approvals: new HookApprovals(path.join(directory, "approvals.json")),
        folder: alias,
        fs: {
            ...nodeHookFs,
            watch: (_root, listener) => {
                emit = listener;

                return { close: () => {} };
            },
        },
        isIdle: () => true,
        onChange: () => {},
        send: (prompt) => {
            sent.push(prompt);
        },
    });
    await runner.start();
    await runner.approve(await hashOf());
});

afterEach(() => {
    runner.stop();
    rmSync(directory, { force: true, recursive: true });
});

const stateOf = async (): Promise<string> => {
    const view = await runner.view();

    return view.state;
};

const hashOf = async (): Promise<string> => {
    const view = await runner.view();

    return view.hash as string;
};

/** Real timers: the folder is read for real, and that does not wait for a fake clock. */
const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, DEBOUNCE_MS + 250);
    });
};

describe("on a real folder", () => {
    it("fires for a real file", async () => {
        writeFileSync(path.join(folder, "src", "a.ts"), "edited");
        emit("change", "src/a.ts");
        await settle();

        expect(sent).toHaveLength(1);
    });

    it("never fires for a symlink to a file outside the folder, or a path through a link to a folder outside", async () => {
        emit("change", "src/link.ts");
        emit("change", "escape/secret.ts");
        await settle();

        expect(sent).toEqual([]);
    });

    it("does not read a hooks file that sits behind a link", async () => {
        rmSync(path.join(folder, ".neore"), { force: true, recursive: true });
        mkdirSync(path.join(outside, ".neore"));
        writeFileSync(path.join(outside, ".neore", "hooks.json"), "{}");
        symlinkSync(path.join(outside, ".neore"), path.join(folder, ".neore"));

        expect(await stateOf()).toBe("invalid");
    });
});
