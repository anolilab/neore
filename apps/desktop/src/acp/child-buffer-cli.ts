// The child-buffer measurement of plans/acp-s7-children.md, from a log of a real agent's output.
//
//   pnpm --filter @neore/desktop exec tsx src/acp/child-buffer-cli.ts <agent-output.jsonl> [budgetBytes]
//
// The log is the agent's stdout, one JSON-RPC frame per line, from a session that ran a child-heavy task (several
// children started in parallel, each with long output). Capture it by starting the agent through a wrapper that
// `tee`s its stdout, in a folder the desktop approved. The same numbers are logged by the desktop itself at the end of
// each session ("child output buffered before its parent: peak … bytes"), which needs no wrapper.
//
// Prints, per agent session, the child events seen, the peak bytes that waited for a parent call and how many events
// a budget would have dropped. The budget to fix is the largest peak over several runs, with headroom.
import { readFileSync } from "node:fs";

import { measureChildBuffer, updatesBySession } from "./child-buffer";

const [file, budget] = process.argv.slice(2);

if (file === undefined) {
    console.error("usage: child-buffer-cli.ts <agent-output.jsonl> [budgetBytes]");
    process.exitCode = 1;
} else {
    const sessions = updatesBySession(readFileSync(file, "utf8"));

    for (const [sessionId, updates] of sessions) {
        const measured = measureChildBuffer(updates, budget === undefined ? undefined : Number(budget));

        console.log(JSON.stringify({ sessionId, updates: updates.length, ...measured }));
    }
}
