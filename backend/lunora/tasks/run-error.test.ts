/** What a failed task round persists for the user to read: our own wording, never raw provider text. */
import { describe, expect, it } from "vitest";

import { USER_FACING_ERRORS } from "../chat/lib/user-facing-error";
import { TaskRunError, taskErrorMessage } from "./run-error";

describe(taskErrorMessage, () => {
    it("never persists a raw gateway error", () => {
        const raw = new Error("Gateway model proxy failed (502): upstream https://internal.example/v1 said no");

        expect(taskErrorMessage(raw, "gpt-x")).toBe(USER_FACING_ERRORS.unavailable);
    });

    it("blames the user's own endpoint for a custom model", () => {
        expect(taskErrorMessage(new Error("connect ECONNREFUSED 10.0.0.1:443"), "custom:p1/llama")).toBe(USER_FACING_ERRORS.customEndpoint);
    });

    it("keeps the runner's own wording", () => {
        expect(taskErrorMessage(new TaskRunError("The agent finished without producing an answer."), undefined)).toBe(
            "The agent finished without producing an answer.",
        );
    });
});
