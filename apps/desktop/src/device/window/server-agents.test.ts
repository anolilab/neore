import { describe, expect, it } from "vitest";

import { addAgentQuestion, agentKeyFor, agentLine, approvalLine, approveQuestion, unsupportedNote } from "./server-agents";

describe("a server's coding agents in the local window", () => {
    it("words an agent's key from its name and keeps it unique among the server's agents", () => {
        expect(agentKeyFor("Claude Code", [])).toBe("claude-code");
        expect(agentKeyFor("Claude Code", ["claude-code"])).toBe("claude-code-2");
        expect(agentKeyFor("  ///  ", [])).toBe("agent");
        expect(agentKeyFor("É".repeat(5), [])).toBe("agent");
    });

    it("asks to confirm the exact command line the server will run", () => {
        const question = addAgentQuestion("build-box", "Claude", "/opt/agent/bin/agent", ["--acp", "--verbose"]);

        expect(question).toContain("build-box will run");
        expect(question).toContain("/opt/agent/bin/agent --acp --verbose");
    });

    it("refuses to confirm a command line the native dialog would cut", () => {
        expect(() => addAgentQuestion("build-box", "Claude", "x".repeat(2000), [])).toThrow("too long");
        expect(() => approveQuestion("build-box", "Claude", `/${"x".repeat(2000)}`)).toThrow("too long");
    });

    it("names the server and the rights in the approval question", () => {
        const question = approveQuestion("build-box", "Claude", "/srv/app");

        expect(question).toContain("/srv/app on build-box");
        expect(question).toContain("with your rights on build-box");
        expect(question).toContain("asks before each action");
    });

    it("lists agents and approvals by name and path", () => {
        const agent = { args: ["--acp"], command: "/opt/a", envNames: [], install: null, key: "claude", label: "Claude" };

        expect(agentLine(agent)).toBe("Claude: /opt/a --acp");
        expect(approvalLine({ acpAgents: [agent] }, { agentKey: "claude", folderId: "f", folderLabel: "app", folderPath: "/srv/app" })).toBe("Claude in /srv/app");
        expect(approvalLine({ acpAgents: [] }, { agentKey: "gone", folderId: "f", folderLabel: "app", folderPath: "/srv/app" })).toBe("gone in /srv/app");
    });

    it("says to install again only for a host that answered without coding agents", () => {
        expect(unsupportedNote({ agentsSupported: false, name: "build-box" })).toContain("Install host software");
        expect(unsupportedNote({ agentsSupported: true, name: "build-box" })).toBeNull();
        expect(unsupportedNote({ agentsSupported: null, name: "build-box" })).toBeNull();
    });
});
