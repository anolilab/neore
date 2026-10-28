/**
 * How an agent switch is stored and read back: one `system` row with no text whose payload
 * rides in `providerMetadata`. A reader that does not know the marker must still see an
 * ordinary, harmless row, and a marker that does not check must read as no switch at all.
 */
import { describe, expect, it } from "vitest";

import { AGENT_SWITCH_KEY, agentSwitchOf, agentSwitchRowContent, lastAgentSwitch } from "./agent-switch-logic";
import type { AgentSwitchPart } from "./agent-switch-validators";
import { docsToModelMessages } from "./mapping";
import { toUIMessages } from "./ui-messages";

const part = (from: string, to: string): AgentSwitchPart => {
    return { from: { kind: "model", model: from }, mode: "full", startMessageId: "m1", to: { kind: "model", model: to } };
};

const row = (id: string, order: number, message: unknown, extra: Record<string, unknown> = {}) =>
    ({ _creationTime: order, _id: id, message, order, status: "success", stepOrder: 0, threadId: "t1", tool: false, ...extra }) as never;

describe("agentSwitchOf", () => {
    it("reads the part back from the row that carries it", () => {
        expect(agentSwitchOf(agentSwitchRowContent(part("a", "b")))).toStrictEqual(part("a", "b"));
    });

    it("sees nothing on a row without the marker, or with other metadata", () => {
        expect(agentSwitchOf({})).toBeUndefined();
        expect(agentSwitchOf({ providerMetadata: { neoreJob: { jobId: "j" } } })).toBeUndefined();
    });

    it("reads a marker that does not check as no switch, rather than guessing", () => {
        expect(agentSwitchOf({ providerMetadata: { [AGENT_SWITCH_KEY]: { to: "b" } } })).toBeUndefined();
        expect(agentSwitchOf({ providerMetadata: { [AGENT_SWITCH_KEY]: { ...part("a", "b"), mode: "native" } } })).toBeUndefined();
    });
});

describe("agentSwitchRowContent", () => {
    it("refuses to build a row from a part that does not check", () => {
        expect(() => agentSwitchRowContent({ ...part("a", "b"), to: { kind: "host" } } as never)).toThrow();
    });
});

describe("lastAgentSwitch", () => {
    it("takes the newest switch of a path that is listed newest first", () => {
        const rows = [{}, agentSwitchRowContent(part("b", "c")), {}, agentSwitchRowContent(part("a", "b"))];

        expect(lastAgentSwitch(rows)?.to.model).toBe("c");
        expect(lastAgentSwitch([{}, {}])).toBeUndefined();
    });
});

describe("what readers do with a switch row", () => {
    const switchRow = row("s1", 1, { content: "", role: "system" }, { providerMetadata: agentSwitchRowContent(part("a", "b")).providerMetadata });

    it("keeps it out of the model's context", () => {
        const context = docsToModelMessages([row("u1", 0, { content: "hi", role: "user" }), switchRow, row("u2", 2, { content: "again", role: "user" })]);

        expect(context.map((message) => message.role)).toStrictEqual(["user", "user"]);
    });

    it("shows it in the transcript as a data part between the turns around it", () => {
        const messages = toUIMessages([row("u1", 0, { content: "hi", role: "user" }), switchRow, row("u2", 2, { content: "again", role: "user" })]);

        expect(messages.map((message) => message.role)).toStrictEqual(["user", "system", "user"]);
        expect(messages[1]?.parts).toStrictEqual([{ data: part("a", "b"), id: "s1", type: "data-agentSwitch" }]);
    });

    it("shows a system row whose marker does not check as the plain row it is", () => {
        const broken = row("s2", 1, { content: "", role: "system" }, { providerMetadata: { [AGENT_SWITCH_KEY]: { to: "b" } } });
        const [message] = toUIMessages([broken]);

        expect(message?.parts.map((p) => p.type)).toStrictEqual(["text"]);
    });
});
