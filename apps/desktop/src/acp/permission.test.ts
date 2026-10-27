import { describe, expect, it, vi } from "vitest";

import type { PermissionRequest } from "./permission";
import { coreGate, declineGate, describePermission } from "./permission";

const OPTIONS = [
    { kind: "allow_once", name: "Allow", optionId: "allow" },
    { kind: "allow_always", name: "Always", optionId: "always" },
    { kind: "reject_once", name: "Reject", optionId: "reject" },
];

const request = (toolCall: Record<string, unknown>, options: unknown = OPTIONS): PermissionRequest => {
    return { agentLabel: "Agent", folder: "/work", params: { options, sessionId: "agent-1", toolCall }, scrub: (text) => text, sessionId: "s1" };
};

describe("describing a request", () => {
    it("reads the tool, target and command, and keeps every detail the agent sent", () => {
        const described = describePermission(
            request({ kind: "execute", locations: [{ line: 3, path: "/work/a.ts" }], rawInput: { command: "npm test" }, title: "Run tests", toolCallId: "c1" }),
        );

        expect(described).toMatchObject({ command: "npm test", detailsComplete: true, folder: "/work", target: "/work/a.ts:3", tool: "Run tests", toolKind: "execute" });
        expect(described.details).toContain("npm test");
        expect(described.options.map((option) => option.optionId)).toEqual(["allow", "always", "reject"]);
    });

    it("finds a command given as an argument list and a target given in the input", () => {
        const described = describePermission(request({ rawInput: { command: ["git", "push"], file_path: "/work/b" }, title: "Push" }));

        expect(described.command).toBe("git push");
        expect(described.target).toBe("/work/b");
    });

    it("has no complete details when the agent sent only a title, or more than it fits", () => {
        expect(describePermission(request({ title: "Do something" })).detailsComplete).toBe(false);
        const big = describePermission(request({ rawInput: { text: "x".repeat(70_000) }, title: "Big" }));

        expect(big.detailsComplete).toBe(false);
        expect(describePermission(request({ content: [{ path: "/work/a", type: "diff" }], title: "Edit" })).detailsComplete).toBe(true);
    });
});

describe("an agent that puts a secret in a request", () => {
    it("is scrubbed from every text the user reads, and the option ids stay as sent", () => {
        const scrub = (text: string): string => text.replaceAll("s3cr3t-value", "***");
        const described = describePermission({
            ...request({ content: [{ text: "token s3cr3t-value", type: "content" }], locations: [{ path: "/work/s3cr3t-value" }], rawInput: { command: "curl -H s3cr3t-value" }, title: "Call s3cr3t-value" }, [
                { kind: "allow_once", name: "Allow s3cr3t-value", optionId: "s3cr3t-value" },
            ]),
            scrub,
        });

        expect(JSON.stringify([described.command, described.details, described.target, described.tool, described.options.map((option) => option.name)])).not.toContain("s3cr3t-value");
        expect(described.command).toBe("curl -H ***");
        expect(described.options[0].optionId).toBe("s3cr3t-value");
    });
});

describe("the core gate", () => {
    const gate = (answer: string | Error) => {
        const core = {
            acpPermissionAsk: vi.fn(async (_request: string) => {
                if (answer instanceof Error) {
                    throw answer;
                }

                return answer;
            }),
            acpPermissionCancelSession: vi.fn(),
        };

        return { core, gate: coreGate(core) };
    };

    it("passes the described request to the core and returns the option the core chose", async () => {
        const { core, gate: target } = gate("{\"outcome\":\"selected\",\"optionId\":\"allow\"}");

        expect(await target.ask(request({ rawInput: { command: "ls" }, title: "List" }))).toEqual({ optionId: "allow", outcome: "selected" });
        const [[sent]] = core.acpPermissionAsk.mock.calls;

        expect(JSON.parse(sent)).toMatchObject({ sessionId: "s1", tool: "List" });
    });

    it("cancels on an answer the agent did not offer, a malformed one, or a failure", async () => {
        const answers = ["{\"outcome\":\"selected\",\"optionId\":\"invented\"}", "not json", "{\"outcome\":\"selected\"}", new Error("core down")];
        const outcomes = await Promise.all(answers.map((answer) => gate(answer).gate.ask(request({ title: "x" }))));

        expect(outcomes.every((outcome) => outcome.outcome === "cancelled")).toBe(true);
        expect(outcomes).toHaveLength(answers.length);
    });

    it("hands a session cancel to the core", () => {
        const { core, gate: target } = gate("{\"outcome\":\"cancelled\"}");

        target.cancelSession("s1");
        expect(core.acpPermissionCancelSession).toHaveBeenCalledWith("s1");
    });
});

describe("the decline gate", () => {
    it("answers with the agent's reject-once option, or cancels when there is none", async () => {
        expect(await declineGate.ask(request({ title: "x" }))).toEqual({ optionId: "reject", outcome: "selected" });
        expect(await declineGate.ask(request({ title: "x" }, [OPTIONS[0]]))).toEqual({ outcome: "cancelled" });
    });
});
