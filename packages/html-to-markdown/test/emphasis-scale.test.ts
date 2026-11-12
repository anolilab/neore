import { describe, expect, it } from "vitest";

import { emphasisSteps } from "../src/commonmark-rules";
import TurndownService from "../src/index";

/*
 * Long runs of emphasis must cost work in proportion to their length. The test counts the
 * steps the emphasis walks take (siblings visited and children checked), not the time. A walk
 * that rescans the run from every member makes that count quadratic in the run length.
 */

// Each member takes a few steps to find its run's ends, so the count stays within this many per member.
const STEPS_PER_MEMBER = 20;

function convertCountingSteps(html: string): { output: string; steps: number } {
    emphasisSteps.count = 0;

    const output = new TurndownService().turndown(html);

    return { output, steps: emphasisSteps.count };
}

describe("long emphasis runs stay linear (Qodo)", () => {
    it.each([1000, 4000])("walks a run of %i adjacent elements in a bounded number of steps", (count) => {
        const result = convertCountingSteps("<em>x</em>".repeat(count));

        expect(result.output).toBe(`_${"x".repeat(count)}_`);
        expect(result.steps).toBeLessThan(STEPS_PER_MEMBER * count);
    });

    it.each([1000, 4000])("checks a same-kind parent with %i children in a bounded number of steps", (count) => {
        const result = convertCountingSteps(`<em>${"<em>x</em>".repeat(count)}</em>`);

        expect(result.output).toBe(`_${"x".repeat(count)}_`);
        expect(result.steps).toBeLessThan(STEPS_PER_MEMBER * count);
    });
});
