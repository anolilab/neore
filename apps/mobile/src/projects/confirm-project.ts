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
 * One direct read of one project, bounded by `timeoutMs`. It asks the server instead of waiting for a live subscription,
 * which after a reconnect may only resume without answering.
 */
export const confirmProject = async (client: ConfirmClient, projectId: string, timeoutMs = CONFIRM_READ_TIMEOUT_MS): Promise<ConfirmOutcome> => {
    const controller = new AbortController();
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
            const project = await client.query(api.projects.functions.getProject, { projectId: projectId as Id<"projects"> }, { signal: controller.signal });

            return { found: Boolean(project), kind: "answered" };
        } catch (error: unknown) {
            return classify(error);
        }
    };

    try {
        return await Promise.race([read(), deadline]);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * What one refresh tick does for a screen whose write controls wait: one read, reported to the connection and to the
 * screen. An answer for a missing project is still a successful read, but the screen is told the project is gone.
 * `show(undefined)` clears what was shown. The returned function drops the result when the screen moves on first.
 */
export const confirmOnTick = ({
    client,
    projectId,
    reportRead,
    show,
}: {
    client: ConfirmClient;
    projectId: string;
    reportRead: (outcome: "failed" | "succeeded") => void;
    show: (view: ConfirmView | undefined) => void;
}): () => void => {
    let isCancelled = false;

    settleQuietly(async () => {
        const outcome = await confirmProject(client, projectId);

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
    };
};
