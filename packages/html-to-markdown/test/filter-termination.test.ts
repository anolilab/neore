import { describe, expect, it } from "vitest";

import TurndownService from "../src/turndown";

describe("rule filters that add rules", () => {
    it("stop searching after the rules that existed when the search began", () => {
        const service = new TurndownService();
        let calls = 0;

        service.addRule("adds-a-rule", {
            filter(this: unknown, node: Node) {
                calls += 1;

                // The guard fails the test instead of hanging it if the search never ends.
                if (calls > 1000) {
                    throw new Error("the rule search did not end");
                }

                if (node.nodeName === "P") {
                    service.addRule(`added-${calls}`, {
                        filter: () => false,
                        replacement: (content: string) => content,
                    });
                }

                return false;
            },
            replacement: (content: string) => content,
        });

        expect(service.turndown("<p>x</p>")).toBe("x");
        expect(calls).toBeLessThan(1000);
    });
});
