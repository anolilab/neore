import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useHasOpened } from "./use-has-opened";

describe(useHasOpened, () => {
    it("stays false until the first open, then latches", () => {
        const { rerender, result } = renderHook(({ open }) => useHasOpened(open), { initialProps: { open: false } });

        expect(result.current).toBe(false);

        rerender({ open: true });

        expect(result.current).toBe(true);

        rerender({ open: false });

        expect(result.current).toBe(true);
    });
});
