import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

import { SAMPLE_RATE } from "./channels.js";
import type { Language } from "./settings.js";
import { isLanguage } from "./settings.js";
import { wavBytes } from "./wav.js";

/** Waiting for text after the audio is in: model load is mostly done by then, so this covers only the decode. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 1_048_576;
const STDERR_TAIL_BYTES = 2000;
/** Variables the helper needs and nothing else: it gets no credentials and no proxy settings from our environment. */
const ENV_ALLOWLIST = ["HOME", "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE"];

export type RecognizerFailure = "crashed" | "failed" | "timeout" | "unavailable";

export class RecognizerError extends Error {
    public readonly code: RecognizerFailure;

    /** The end of the helper's stderr, for the log. It carries engine messages, not audio or text. */
    public readonly detail: string;

    public constructor(code: RecognizerFailure, message: string, detail = "") {
        super(message);
        this.name = "RecognizerError";
        this.code = code;
        this.detail = detail;
    }
}

export interface HelperCommand {
    /** Fixed arguments that come before the recogniser's own (a script path, when the helper is a script). */
    args: ReadonlyArray<string>;
    command: string;
}

export interface Transcript {
    segments: string[];
    text: string;
}

export interface Recognizer {
    /** Resolves once the helper process has ended (killed, crashed or done), so its model file is no longer open. */
    exited: () => Promise<void>;
    /** Stops the helper. Safe to call after it has exited. */
    kill: () => void;
    /** Called once if the helper exits or fails to start before `transcribe` was called. */
    onEarlyExit: (listener: (error: RecognizerError) => void) => void;
    pid: number | undefined;
    /** Writes the audio to the helper's stdin as a WAV, and resolves with its text once it exits cleanly. Call once. */
    transcribe: (pcm: Buffer) => Promise<Transcript>;
}

export interface RecognizerOptions {
    /** Where the helper runs: a folder we control, so any file it might write lands there. */
    cwd: string;
    helper: HelperCommand;
    /** What the user is dictating in; `auto` lets the model detect it. Checked here too, since it ends up in the helper's arguments. */
    language: Language;
    modelPath: string;
    spawn?: (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => ChildProcess;
    timeoutMs?: number;
}

/** The timestamps the helper prints before each segment. */
const TIMESTAMP = /^\[\d+:\d{2}:\d{2}\.\d{3} --> \d+:\d{2}:\d{2}\.\d{3}\]\s*/u;
const LINE_BREAK = /\r?\n/u;
/** A segment that is only an annotation (`[BLANK_AUDIO]`, `(music)`, `*applause*`): the model's note about silence, not speech. */
const ANNOTATION = /^(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)$/u;

/**
 * How the helper is told to put its text on stdout. With `-f -` it has no file name to derive an output from, and upstream's stdin
 * mode (`-otxt`) opens `/dev/stdout` (the console, `CON`, on Windows). Neither is our pipe: a pipe is a socket here, which cannot be
 * opened by path, so the helper exits cleanly with no text. An output name that is not `-` makes it print each segment to
 * stdout itself, one line per segment behind a timestamp (`parseTranscript` strips it), and with no `-o*` format flag no file is
 * opened under that name. The CI run of the real helper on every OS is what shows this.
 */
const OUTPUT_ARGUMENTS = ["-of", "unused"];

/** One segment per line of the recogniser's output, timestamps removed; empty lines and annotations are dropped. */
export const parseTranscript = (output: string): Transcript => {
    const segments = output
        .split(LINE_BREAK)
        .map((line) => line.replace(TIMESTAMP, "").trim())
        .filter((line) => line !== "" && !ANNOTATION.test(line));

    return { segments, text: segments.join(" ") };
};

const helperEnvironment = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};

    for (const name of ENV_ALLOWLIST) {
        if (process.env[name] !== undefined) {
            env[name] = process.env[name];
        }
    }

    return env;
};

/**
 * Starts the helper at once, so it loads the model while the user is still speaking, and then reads the audio
 * from its stdin: the audio never touches a file. Whatever the helper does (crash, hang, garbage), the app only sees a
 * `RecognizerError`.
 */
export const startRecognizer = (options: RecognizerOptions): Recognizer => {
    if (!isLanguage(options.language)) {
        throw new RecognizerError("unavailable", "The dictation language is not supported");
    }

    const spawn = options.spawn ?? nodeSpawn;
    const timeoutMs = options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
    // `-l`: the default is English, which would turn other languages into English, so it is always given (`auto` detects).
    const args = [...options.helper.args, "-m", options.modelPath, "-f", "-", ...OUTPUT_ARGUMENTS, "-np", "-l", options.language];
    const child = spawn(options.helper.command, args, {
        cwd: options.cwd,
        env: helperEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = "";
    let outputTooLarge = false;
    let transcribing = false;
    let ended = undefined as RecognizerError | "clean" | undefined;
    const earlyExitListeners: ((error: RecognizerError) => void)[] = [];
    const endedListeners: (() => void)[] = [];

    /** Read through a function: TypeScript would otherwise narrow `ended` for good after the first check. */
    const failure = (): RecognizerError | undefined => ended instanceof RecognizerError ? ended : undefined;

    const end = (outcome: RecognizerError | "clean"): void => {
        if (ended !== undefined) {
            return;
        }

        ended = outcome;

        if (outcome !== "clean" && !transcribing) {
            for (const listener of earlyExitListeners) {
                listener(outcome);
            }
        }

        for (const listener of endedListeners) {
            listener();
        }
    };

    // A killed helper makes the write to its stdin fail with EPIPE; unhandled, that would take the app down with it.
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;

        if (stdoutBytes > MAX_STDOUT_BYTES) {
            outputTooLarge = true;
            child.kill();

            return;
        }

        stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
        end(
            new RecognizerError(
                "unavailable",
                error.code === "ENOENT" ? "The speech engine is not installed" : "The speech engine could not be started",
                String(error),
            ),
        );
    });
    child.once("close", (code, signal) => {
        if (outputTooLarge) {
            end(new RecognizerError("failed", "The speech engine returned too much text", stderrTail));
        } else if (signal !== null) {
            end(new RecognizerError("crashed", "The speech engine stopped unexpectedly", `${signal}\n${stderrTail}`));
        } else if (code === 0) {
            end("clean");
        } else {
            end(new RecognizerError("failed", "The speech engine could not read the audio", `exit ${code}\n${stderrTail}`));
        }
    });

    const kill = (): void => {
        if (ended === undefined) {
            child.kill();
        }
    };

    const transcribe = async (pcm: Buffer): Promise<Transcript> => {
        transcribing = true;

        const earlier = failure();

        if (earlier !== undefined) {
            throw earlier;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        const finished = new Promise<void>((resolve) => {
            endedListeners.push(resolve);

            if (ended !== undefined) {
                resolve();
            }
        });
        const timedOut = new Promise<"timeout">((resolve) => {
            timer = setTimeout(resolve, timeoutMs, "timeout");
        });

        child.stdin?.end(wavBytes(pcm, SAMPLE_RATE));

        try {
            if (await Promise.race([finished, timedOut]) === "timeout") {
                child.kill();

                throw new RecognizerError("timeout", "The speech engine took too long", stderrTail);
            }
        } finally {
            clearTimeout(timer);
        }

        const later = failure();

        if (later !== undefined) {
            throw later;
        }

        return parseTranscript(Buffer.concat(stdout).toString("utf8"));
    };

    return {
        exited: async () => {
            await new Promise<void>((resolve) => {
                if (ended === undefined) {
                    endedListeners.push(resolve);
                } else {
                    resolve();
                }
            });
        },
        kill,
        onEarlyExit: (listener) => {
            const earlier = failure();

            if (earlier !== undefined && !transcribing) {
                listener(earlier);

                return;
            }

            earlyExitListeners.push(listener);
        },
        pid: child.pid,
        transcribe,
    };
};
