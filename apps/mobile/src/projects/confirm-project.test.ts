import { api } from "@neore/backend/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfirmClient } from "./confirm-project";
import { CONFIRM_READ_TIMEOUT_MS, confirmOnTick, confirmProject } from "./confirm-project";

/** A client whose one read is answered, refused or left pending by the test. */
const clientWith = (query: ConfirmClient["query"]): ConfirmClient => ({ query } as ConfirmClient);

const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe("confirmProject", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("reads the project by id and reports an answer, whether or not the project is still there", async () => {
        const query = vi.fn(async () => null);

        await expect(confirmProject(clientWith(query as never), "p1")).resolves.toEqual({ kind: "answered" });

        expect(query).toHaveBeenCalledWith(api.projects.functions.getProject, { projectId: "p1" }, { signal: expect.any(AbortSignal) });
    });

    it("reports a refusal with the server's message", async () => {
        const client = clientWith((async () => {
            throw new Error("FORBIDDEN");
        }) as never);

        await expect(confirmProject(client, "p1")).resolves.toEqual({ kind: "refused", message: "FORBIDDEN" });
    });

    it("reports nothing for a network failure", async () => {
        const client = clientWith((async () => {
            throw new TypeError("Network request failed");
        }) as never);

        await expect(confirmProject(client, "p1")).resolves.toEqual({ kind: "unreachable" });
    });

    it("reports nothing for an unauthorized read, which the next refresh reads again", async () => {
        const client = clientWith((async () => {
            throw coded("Unauthorized", "UNAUTHORIZED");
        }) as never);

        await expect(confirmProject(client, "p1")).resolves.toEqual({ kind: "unreachable" });
    });

    it("gives up a read that never answers after the deadline, and aborts it", async () => {
        let signal: AbortSignal | undefined;
        const client = clientWith(((_function: unknown, _args: unknown, options: { signal: AbortSignal }) => {
            signal = options.signal;

            return new Promise(() => {});
        }) as never);

        const outcome = confirmProject(client, "p1");

        await vi.advanceTimersByTimeAsync(CONFIRM_READ_TIMEOUT_MS);

        await expect(outcome).resolves.toEqual({ kind: "unreachable" });
        expect(signal?.aborted).toBe(true);
    });

    it("settles a read given up after its deadline without an unhandled failure", async () => {
        const pending = Promise.withResolvers<never>();
        const client = clientWith((() => pending.promise) as never);

        const outcome = confirmProject(client, "p1", 1000);

        await vi.advanceTimersByTimeAsync(1000);
        await expect(outcome).resolves.toEqual({ kind: "unreachable" });

        // The abort lands after the deadline; the read's own rejection must not escape.
        pending.reject(coded("Aborted", "ABORTED"));
        await vi.advanceTimersByTimeAsync(0);
    });
});

describe("confirmOnTick", () => {
    it("reports an answer to the connection and the screen", async () => {
        const reportRead = vi.fn();
        const showRefusal = vi.fn();

        confirmOnTick({ client: clientWith((async () => null) as never), projectId: "p1", reportRead, showRefusal });

        await vi.waitFor(() => {
            expect(reportRead).toHaveBeenCalledWith("succeeded");
        });
        expect(showRefusal).toHaveBeenCalledWith(undefined);
    });

    it("drops the result of a read the screen has moved on from", async () => {
        const pending = Promise.withResolvers<null>();
        const reportRead = vi.fn();
        const showRefusal = vi.fn();

        const cancel = confirmOnTick({ client: clientWith((() => pending.promise) as never), projectId: "p1", reportRead, showRefusal });

        cancel();
        pending.resolve(null);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(reportRead).not.toHaveBeenCalled();
        expect(showRefusal).not.toHaveBeenCalled();
    });
});
