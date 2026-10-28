import { describe, expect, it } from "vitest";

import { agentSwitchOf, agentSwitchRowContent } from "./agent-switch-logic";
import { readAgentSwitch } from "./agent-switch-shape";

const part = { from: { kind: "model" as const, model: "a/one" }, mode: "full" as const, startMessageId: "m1", to: { kind: "model" as const, model: "b/two" } };

describe("readAgentSwitch", () => {
    it("reads what the writer stores, as the validated reader does", () => {
        const { providerMetadata } = agentSwitchRowContent(part);

        expect(readAgentSwitch({ providerMetadata })).toStrictEqual(part);
        expect(readAgentSwitch({ providerMetadata })).toStrictEqual(agentSwitchOf({ providerMetadata }));
    });

    it("reads nothing from a row that is not a switch or has the wrong shape", () => {
        expect(readAgentSwitch({})).toBeUndefined();
        expect(readAgentSwitch({ providerMetadata: { neoreAgentSwitch: { ...part, mode: "delta" } } })).toBeUndefined();
        expect(readAgentSwitch({ providerMetadata: { neoreAgentSwitch: { ...part, to: { kind: "host", model: 3 } } } })).toBeUndefined();
        expect(readAgentSwitch({ providerMetadata: { neoreAgentSwitch: "x" } })).toBeUndefined();
    });
});
