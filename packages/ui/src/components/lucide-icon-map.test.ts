import { iconNames } from "lucide-react/dynamic";
import { describe, expect, it } from "vitest";

import getLucideIcon from "./lucide-icon-map";

describe("the lucide icon map", () => {
    it("knows exactly lucide's own names, aliases included", () => {
        // lucide's dynamic name list is the reference: it is what project icons were checked against before the map.
        const unknown = iconNames.filter((name: string) => getLucideIcon(name) === undefined);

        expect(unknown).toStrictEqual([]);
        expect(getLucideIcon("rocket")).toBeDefined();
        // An official alias of arrow-up-0-1.
        expect(getLucideIcon("arrow-up-01")).toBe(getLucideIcon("arrow-up-0-1"));
    });

    it.each(["arrow-up01", "arrowup-0-1", "a-arrowdown", "icon", "create-lucide-icon", "Rocket", ""])(
        "does not resolve %j, which is not one of lucide's names",
        (name: string) => {
            expect(getLucideIcon(name)).toBeUndefined();
        },
    );
});
