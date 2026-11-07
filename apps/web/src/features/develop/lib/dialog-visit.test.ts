import { describe, expect, it } from "vitest";

import { createDialogVisits } from "./dialog-visit";

describe(createDialogVisits, () => {
    it("lets a request write its result only into the visit it started in", () => {
        const visits = createDialogVisits();
        const started = visits.current();

        expect(visits.isCurrent(started)).toBe(true);

        // Closed and opened again while the request was in flight: its result belongs to a visit that is over.
        visits.next();
        visits.next();

        expect(visits.isCurrent(started)).toBe(false);
        expect(visits.isCurrent(visits.current())).toBe(true);
    });
});
