// The hidden-window measurement of plans/acp-s4-throttling.md, from a machine other than the one under test.
//
//   pnpm --filter @neore/desktop exec tsx src/acp/throttling-cli.ts sample 60 > samples.jsonl   (one hour, every 10 s)
//   pnpm --filter @neore/desktop exec tsx src/acp/throttling-cli.ts report samples.jsonl
//
// `sample` reads the signed-in account's own device list and audit list over the backend's RPC endpoint and writes
// one JSON line per poll. It needs NEORE_BACKEND_URL (the backend origin) and NEORE_BEARER (the account's JWT, from
// the browser's `/api/auth/token`). `report` prints the two numbers the plan decides on (`throttling.ts`).
//
// The tester hides the desktop's main window, starts a long agent turn and, once a minute, sends the thread
// something that makes the backend queue a command for the computer (a message, then Stop). This script times
// whatever commands the hour produced; it creates none itself.
import { readFileSync } from "node:fs";

import { summarize } from "./throttling";

const POLL_MS = 10_000;

interface Sample {
    at: number;
    calls: { claimedAt?: number; createdAt: number; id: string; toolName: string }[];
    lastSeenAt: number[];
}

const rpc = async (path: string, args: unknown): Promise<unknown> => {
    const response = await fetch(new URL("/_lunora/rpc", process.env.NEORE_BACKEND_URL), {
        body: JSON.stringify({ args, functionPath: path }),
        headers: { authorization: `Bearer ${process.env.NEORE_BEARER ?? ""}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        throw new Error(`${path}: ${String(response.status)}`);
    }

    const body = (await response.json()) as { result?: unknown; value?: unknown };

    return body.value ?? body.result ?? body;
};

const sample = async (minutes: number): Promise<void> => {
    const until = Date.now() + minutes * 60_000;

    while (Date.now() < until) {
        try {
            // eslint-disable-next-line no-await-in-loop -- one poll at a time
            const devices = (await rpc("devices_functions:listDevices", {})) as { lastSeenAt?: number }[];
            // eslint-disable-next-line no-await-in-loop -- one poll at a time
            const calls = (await rpc("devices_functions:listDeviceCalls", { limit: 100 })) as { _id: string; claimedAt?: number; createdAt: number; toolName: string }[];
            const line: Sample = {
                at: Date.now(),
                calls: calls.filter((call) => call.toolName.startsWith("acp_")).map(({ _id: id, claimedAt, createdAt, toolName }) => { return { claimedAt, createdAt, id, toolName }; }),
                lastSeenAt: devices.flatMap((device) => device.lastSeenAt === undefined ? [] : [device.lastSeenAt]),
            };

            process.stdout.write(`${JSON.stringify(line)}\n`);
        } catch (error) {
            process.stderr.write(`poll failed: ${(error as Error).message}\n`);
        }

        // eslint-disable-next-line no-await-in-loop -- one poll at a time
        await new Promise((resolve) => {
            setTimeout(resolve, POLL_MS);
        });
    }
};

const report = (file: string): void => {
    const samples = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Sample);
    const claims = new Map<string, { claimedAt: number; createdAt: number }>();

    for (const { calls } of samples) {
        for (const call of calls) {
            if (call.claimedAt !== undefined) {
                claims.set(call.id, { claimedAt: call.claimedAt, createdAt: call.createdAt });
            }
        }
    }

    const heartbeats = samples.flatMap((entry) => entry.lastSeenAt);
    // eslint-disable-next-line unicorn/prefer-iterator-to-array -- the desktop's tsconfig `lib` has no iterator helpers
    const summary = summarize([...claims.values()], heartbeats);

    console.log(JSON.stringify(summary, undefined, 2));
};

const main = async (): Promise<void> => {
    const [command, argument] = process.argv.slice(2);

    if (command === "sample") {
        await sample(Number(argument ?? 60));
    } else if (command === "report" && argument !== undefined) {
        report(argument);
    } else {
        console.error("usage: throttling-cli.ts sample <minutes> | report <samples.jsonl>");
        process.exitCode = 1;
    }
};

await main();
