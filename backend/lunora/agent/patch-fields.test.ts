import { describe, expect, it } from "vitest";

import { projectFieldsSupportingPatch } from "./projects";
import { threadFieldsSupportingPatch } from "./threads";
import { vProjectPatchFields, vThreadPatchFields } from "./validators";

describe("patch field literals", () => {
    it("threadFieldsSupportingPatch lists exactly the keys of vThreadPatchFields", () => {
        expect([...threadFieldsSupportingPatch].toSorted((a, b) => a.localeCompare(b))).toEqual(
            Object.keys(vThreadPatchFields).toSorted((a, b) => a.localeCompare(b)),
        );
    });

    it("projectFieldsSupportingPatch lists exactly the keys of vProjectPatchFields", () => {
        expect([...projectFieldsSupportingPatch].toSorted((a, b) => a.localeCompare(b))).toEqual(
            Object.keys(vProjectPatchFields).toSorted((a, b) => a.localeCompare(b)),
        );
    });
});
