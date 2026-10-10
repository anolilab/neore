/**
 * Process entry: wires the real terminal, network and filesystem into `run`.
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { run } from "./cli";
import type { Context } from "./commands";
import { configPath } from "./config";

/** Read one line; with `secret`, typed characters are not echoed (the prompt still is). */
const readLine: Context["readLine"] = async (prompt, options = {}) => {
    process.stderr.write(prompt);

    const muted = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
    const rl = createInterface({ input: process.stdin, output: options.secret ? muted : process.stderr, terminal: process.stdin.isTTY === true });

    return await new Promise<string | null>((resolve) => {
        let isAnswered = false;

        rl.once("line", (line) => {
            isAnswered = true;
            rl.close();

            if (options.secret) {
                process.stderr.write("\n");
            }

            resolve(line);
        });
        // Ctrl-C at a prompt ends input (the REPL exits) instead of pausing readline.
        rl.once("SIGINT", () => {
            process.stderr.write("\n");
            rl.close();
        });
        rl.once("close", () => {
            if (!isAnswered) {
                resolve(null);
            }
        });
    });
};

const readStdin: Context["readStdin"] = async () => {
    if (process.stdin.isTTY) {
        return null;
    }

    const chunks: Buffer[] = [];

    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks).toString("utf8");
};

// `neore threads show … | head` closes the pipe early; that is the reader
// being done, not an error worth a stack trace. Stop writing, abort whatever
// is still downloading (a streamed reply), and let the process end with 0 on
// its own rather than cutting it off with `process.exit`.
const pipeClosed = new AbortController();

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE" || (pipeClosed.signal.aborted && error.code === "ERR_STREAM_DESTROYED")) {
        if (!pipeClosed.signal.aborted) {
            pipeClosed.abort();
            process.stdout.destroy();
        }

        return;
    }

    throw error;
});

/** `fetch`, cut short once the reader has gone. */
const fetchUntilPipeCloses: typeof fetch = async (input, init) =>
    await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, pipeClosed.signal]) : pipeClosed.signal });

// Ctrl-C mid-stream: end the line cleanly and exit with the conventional 130.
process.once("SIGINT", () => {
    process.stderr.write("\n");
    process.exit(130);
});

const code = await run(process.argv.slice(2), {
    configFile: configPath(),
    fetch: fetchUntilPipeCloses,
    io: { env: process.env, stderr: process.stderr, stdout: process.stdout },
    readFile: async (path) => new Uint8Array(await readFile(path)),
    readLine,
    readStdin,
    stdinIsTTY: process.stdin.isTTY === true,
}).catch((error: unknown) => {
    // The abort above surfaces here when the reader left mid-download.
    if (pipeClosed.signal.aborted) {
        return 0;
    }

    throw error;
});

process.exitCode = pipeClosed.signal.aborted ? 0 : code;
