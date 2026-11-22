import type { LunoraClient } from "@lunora/client";
import { isUnauthorizedError } from "@lunora/client";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";

import { isNetworkFailure } from "../offline/connectivity";
import { settleQuietly } from "../offline/quietly";

/** The longest a project read may run before it is given up, as a network failure is. */
export const CONFIRM_READ_TIMEOUT_MS = 10_000;

/**
 * What one read of a project told the app:
 * - `answered`: the server answered. The connection works. `found` is false when the project is gone or not shared.
 * - `refused`: the server answered with an error. The screen stays blocked and shows the message.
 * - `unreachable`: no verdict. Nothing is learned, so nothing is reported.
 */
export type ConfirmOutcome = { found: boolean; kind: "answered" } | { kind: "refused"; message: string } | { kind: "unreachable" };

/** What a screen shows about its project after a read: the project is gone, or the server refused the read. */
export type ConfirmView = { kind: "gone" } | { kind: "refused"; message: string };

/** The slice of the client this uses, so tests can fake it. */
export type ConfirmClient = Pick<LunoraClient, "query">;

const classify = (error: unknown): ConfirmOutcome => {
    // A lapsed token is renewed by the refresh that follows a reconnect, which reads again on its own.
    if (isNetworkFailure(error) || isUnauthorizedError(error)) {
        return { kind: "unreachable" };
    }

    return { kind: "refused", message: error instanceof Error ? error.message : "This project could not be loaded." };
};

/**
 * A controller that aborts when `source` does (at once, if it already has). `unlink` removes that listener, for a read that
 * finished before its source did.
 */
const linkAbort = (source: AbortSignal | undefined): { controller: AbortController; unlink: () => void } => {
    const controller = new AbortController();
    const abort = (): void => {
        controller.abort();
    };

    if (source?.aborted === true) {
        abort();
    } else {
        source?.addEventListener("abort", abort, { once: true });
    }

    return {
        controller,
        unlink: () => {
            source?.removeEventListener("abort", abort);
        },
    };
};

/**
 * One direct read of one project, bounded by `timeoutMs`. It asks the server instead of waiting for a live subscription,
 * which after a reconnect may only resume without answering. `cancel` is the caller giving up (its screen moved on): the
 * read is aborted then, not left to run until its deadline.
 */
export const confirmProject = async (
    client: ConfirmClient,
    projectId: string,
    timeoutMs = CONFIRM_READ_TIMEOUT_MS,
    cancel?: AbortSignal,
): Promise<ConfirmOutcome> => {
    const { controller, unlink } = linkAbort(cancel);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ConfirmOutcome>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve({ kind: "unreachable" });
        }, timeoutMs);
    });
    // A read given up after its deadline still settles later; its failure is classified here, so it is never unhandled.
    const read = async (): Promise<ConfirmOutcome> => {
        try {
            // Primary: "not there" is taken as proof, so a lagging replica must not answer it.
            const project = await client.query(
                api.projects.functions.getProject,
                { primary: true, projectId: projectId as Id<"projects"> },
                { signal: controller.signal },
            );

            return { found: Boolean(project), kind: "answered" };
        } catch (error: unknown) {
            // An aborted read was given up by its caller or its deadline: nothing about the connection is learned.
            return controller.signal.aborted ? { kind: "unreachable" } : classify(error);
        }
    };

    try {
        return await Promise.race([read(), deadline]);
    } finally {
        clearTimeout(timer);
        unlink();
    }
};

/**
 * What one refresh tick does for a screen whose write controls wait: one read, reported to the connection and to the
 * screen. An answer for a missing project is still a successful read, but the screen is told the project is gone.
 * `show(undefined)` clears what was shown. The returned function drops the result when the screen moves on first.
 * `interrupt` aborts the read when the connection drops while it is out: that read reports nothing, so a success that
 * arrives late cannot clear an offline state that came after it.
 */
export const confirmOnTick = ({
    client,
    interrupt,
    projectId,
    reportRead,
    show,
}: {
    client: ConfirmClient;
    interrupt?: AbortSignal;
    projectId: string;
    reportRead: (outcome: "failed" | "succeeded") => void;
    show: (view: ConfirmView | undefined) => void;
}): () => void => {
    let isCancelled = false;
    const reading = linkAbort(interrupt);

    settleQuietly(async () => {
        const outcome = await confirmProject(client, projectId, CONFIRM_READ_TIMEOUT_MS, reading.controller.signal);

        if (isCancelled) {
            return;
        }

        if (outcome.kind === "answered") {
            show(outcome.found ? undefined : { kind: "gone" });
            reportRead("succeeded");
        } else if (outcome.kind === "refused") {
            show({ kind: "refused", message: outcome.message });
        }
    });

    return () => {
        isCancelled = true;
        // The screen moved on: the read itself stops now, not at its deadline.
        reading.controller.abort();
        reading.unlink();
    };
};
