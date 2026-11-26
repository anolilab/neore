/**
 * `generateExportFile`'s input: a step queued or retried with the arguments of an earlier deploy still validates.
 */
import { describe, expect, it } from "vitest";

import { generateExportFile } from "./steps";

type Validator = { parse: (value: unknown) => unknown };

describe("generateExportFile input", () => {
    // The validator is the procedure's own; `args` is the only place it lives.
    const { args } = generateExportFile as unknown as { args: Record<string, Validator> };

    it("accepts a replay stored before the grant-revision page count existed", () => {
        expect(() => args.grantRevisionPages!.parse(undefined)).not.toThrow();
    });

    it("still refuses a page count that is not a number", () => {
        expect(() => args.grantRevisionPages!.parse("3")).toThrow();
    });

    it("accepts a replay stored before the suggestion page count existed, and refuses a count that is not a number", () => {
        expect(() => args.taskSuggestionPages!.parse(undefined)).not.toThrow();
        expect(() => args.taskSuggestionsCut!.parse(undefined)).not.toThrow();
        expect(() => args.taskSuggestionPages!.parse("3")).toThrow();
    });
});
