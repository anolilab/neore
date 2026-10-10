import { APERTURE_OPTIONS, CAMERA_OPTIONS, FOCAL_LENGTH_OPTIONS, LENS_OPTIONS } from "@neore/ai/constants/cinema";
import { describe, expect, it, vi } from "vitest";

import type { CinemaOptionGroup } from "./cinema-option-labels";
import { localizeCinemaOption, localizeCinemaOptionLabel, localizeCinemaOptions } from "./cinema-option-labels";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

/** Stands in for `i18n._`: marks what went through translation. */
const translate = (descriptor: { id?: string }) => `«${descriptor.id ?? ""}»`;

describe(localizeCinemaOptions, () => {
    it("translates every description, keeping product names, focal lengths and f-stops", () => {
        const groups: [CinemaOptionGroup, ReadonlyArray<{ description: string; id: string | number | undefined; label: string }>][] = [
            ["camera", CAMERA_OPTIONS],
            ["lens", LENS_OPTIONS],
            ["focalLength", FOCAL_LENGTH_OPTIONS],
            ["aperture", APERTURE_OPTIONS],
        ];

        for (const [group, options] of groups) {
            const localized = localizeCinemaOptions(group, options, translate);

            localized.forEach((option, index) => {
                // The table must carry the registry's exact English, or a reworded
                // option would show a stale translation.
                expect(option.description).toBe(translate({ id: options[index]?.description }));
            });
        }
    });

    it("translates the unset option and generic lens names, but not brands or numbers", () => {
        const [noLens] = localizeCinemaOptions("lens", LENS_OPTIONS, translate);

        expect(noLens?.label).toBe("«None»");
        expect(localizeCinemaOption("lens", { description: "", id: "zoom", label: "Zoom Lens" }, translate).label).toBe("«Zoom Lens»");
        expect(localizeCinemaOption("camera", { description: "", id: "imax", label: "IMAX 70mm" }, translate).label).toBe("IMAX 70mm");
        expect(localizeCinemaOption("aperture", { description: "", id: 2.8, label: "f/2.8" }, translate).label).toBe("f/2.8");
    });

    it("keeps an unknown id's English text", () => {
        const option = { description: "Big and red", id: "red-epic", label: "RED Epic" };

        expect(localizeCinemaOption("camera", option, translate)).toStrictEqual(option);
        expect(localizeCinemaOption("lens", { description: "Proto", id: "constructor", label: "X" }, translate).label).toBe("X");
    });
});

describe(localizeCinemaOptionLabel, () => {
    it("labels the selected option, and nothing when unset or unknown", () => {
        expect(localizeCinemaOptionLabel("lens", LENS_OPTIONS, "macro", translate)).toBe("«Macro»");
        expect(localizeCinemaOptionLabel("camera", CAMERA_OPTIONS, "imax", translate)).toBe("IMAX 70mm");
        expect(localizeCinemaOptionLabel("camera", CAMERA_OPTIONS, undefined, translate)).toBeNull();
        expect(localizeCinemaOptionLabel("camera", CAMERA_OPTIONS, "red-epic", translate)).toBeNull();
    });
});
