/**
 * A message to a worker on a computer needs a person's click whatever the tool's mode says (plans/agent-orchestrator.md
 * §4 Dispatch, S5): `messageWorker` asks when its target runs on a host, and `delegateToSubAgent` asks when it is
 * given a computer to start a worker on. A cloud worker keeps its mode. A headless run passes its flag to the mutation,
 * which refuses a host target there.
 */
import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

import { applyToolPermissions } from "../lib/tool-permissions";
import delegateToSubAgentTool from "./delegate-to-sub-agent";
import messageWorkerTool from "./message-worker";

type Approval = (input: unknown, options: object) => Promise<boolean> | boolean;

/** A tool as the agent calls it: wrapped with the run's ctx. */
const withContext = <T extends object>(tool: T, ctx: Record<string, unknown>): Approval & { execute: (input: unknown, options: object) => unknown } => {
    const wrapped = { ...tool, ctx } as unknown as {
        execute: (input: unknown, options: object) => unknown;
        needsApproval: (this: unknown, input: unknown, options: object) => Promise<boolean> | boolean;
    };

    return Object.assign((input: unknown, options: object) => wrapped.needsApproval.call(wrapped, input, options), {
        execute: (input: unknown, options: object) => (wrapped.execute as (input: unknown, options: object) => unknown).call(wrapped, input, options),
    });
};

const runQueryReturning = (hostWorker: boolean) => vi.fn(async () => hostWorker);

describe("messageWorker", () => {
    it("asks when the worker runs on a computer, and not when it runs in the cloud", async () => {
        const host = withContext(messageWorkerTool, { runQuery: runQueryReturning(true), threadId: "t1", userId: "u1" });
        const cloud = withContext(messageWorkerTool, { runQuery: runQueryReturning(false), threadId: "t1", userId: "u1" });

        expect(await host({ message: "go", worker: "w1" }, {})).toBe(true);
        expect(await cloud({ message: "go", worker: "w1" }, {})).toBe(false);
    });

    it("asks even when the user set the tool to on, and when a timed allow covers it", async () => {
        const ctx = { runQuery: runQueryReturning(true), threadId: "t1", userId: "u1" };
        const describeTool = () => {
            return { key: "builtin:messageWorker", source: "builtin" as const };
        };
        const tools = { messageWorker: { ...messageWorkerTool, ctx } } as unknown as ToolSet;
        const overrides = { "builtin:messageWorker": "auto" as const };
        const plain = applyToolPermissions(tools, describeTool, overrides).tools.messageWorker as unknown as { needsApproval: Approval };
        const granted = applyToolPermissions(
            tools,
            describeTool,
            { "builtin:messageWorker": "ask" },
            { timedGrants: { "builtin:messageWorker": Date.now() + 60_000 } },
        ).tools.messageWorker as unknown as { needsApproval: Approval };

        expect(await plain.needsApproval({ message: "go", worker: "w1" }, {})).toBe(true);
        expect(await granted.needsApproval({ message: "go", worker: "w1" }, {})).toBe(true);
    });

    it("does not ask a headless run, which has nobody to click: the mutation refuses it", async () => {
        const headless = withContext(messageWorkerTool, { headless: true, runQuery: runQueryReturning(true), threadId: "t1", userId: "u1" });

        expect(await headless({ message: "go", worker: "w1" }, {})).toBe(false);
    });

    it("hands a headless run's flag to the mutation", async () => {
        const runMutation = vi.fn(async () => {
            return { runId: "r1", state: "queued", workerId: "w1" };
        });
        const tool = withContext(messageWorkerTool, { dispatchOrigin: "lead", headless: true, runMutation, threadId: "t1", userId: "u1" });

        await tool.execute({ message: "go", worker: "w1" }, { toolCallId: "c1" });
        expect(runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ headless: true }));
    });
});

describe("delegateToSubAgent", () => {
    it("asks when it is given a computer for the worker, and not otherwise", async () => {
        const tool = withContext(delegateToSubAgentTool, { runQuery: runQueryReturning(false), threadId: "t1", userId: "u1" });
        const host = { agentKey: "claude", deviceId: "d1", folderId: "f1" };

        expect(await tool({ host, name: "Coder", persistent: true, task: "x" }, {})).toBe(true);
        expect(await tool({ name: "Coder", persistent: true, task: "x" }, {})).toBe(false);
    });

    it("refuses a computer for a run that is not a worker", async () => {
        const runMutation = vi.fn();
        const tool = withContext(delegateToSubAgentTool, { dispatchOrigin: "lead", runMutation, threadId: "t1", userId: "u1" });
        const result = await tool.execute({ host: { agentKey: "claude", deviceId: "d1", folderId: "f1" }, task: "x" }, { toolCallId: "c1" });

        expect(result).toMatchObject({ status: "failed" });
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("passes the computer and the headless flag to the mutation", async () => {
        const runMutation = vi.fn(async () => {
            return { runId: "r1", workerId: "w1" };
        });
        const tool = withContext(delegateToSubAgentTool, {
            agent: { options: { tools: { a: {} } } },
            dispatchOrigin: "lead",
            headless: true,
            runMutation,
            threadId: "t1",
            userId: "u1",
        });
        const host = { agentKey: "claude", deviceId: "d1", folderId: "f1" };

        await tool.execute({ host, name: "Coder", persistent: true, task: "x" }, { toolCallId: "c1" });
        expect(runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ headless: true, host }));
    });
});
