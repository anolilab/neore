/** What a failed task round persists for the user to read: our own wording, never raw provider text. */
import { describe, expect, it } from "vitest";

import { AgentRunError, LEFT_ORGANIZATION_MESSAGE } from "../chat/lib/agent-run";
import { USER_FACING_ERRORS } from "../chat/lib/user-facing-error";
import { stopsRecurrence, TaskRunError, taskErrorMessage } from "./run-error";

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

    it("tells the owner they left the task's organization, and stops its schedule", () => {
        const refusal = new AgentRunError("left-organization", LEFT_ORGANIZATION_MESSAGE);

        expect(taskErrorMessage(refusal, "gpt-x")).toBe(LEFT_ORGANIZATION_MESSAGE);
        expect(stopsRecurrence(refusal)).toBe(true);
        expect(stopsRecurrence(new TaskRunError("x"))).toBe(false);
    });
});
