import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { FC, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useStaleAfterBackfill } from "./use-usage-backfill";

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {};
        },
    };
});

const KEY = ["usage", "organization-projects"];

const setup = (initial: { backfilling: boolean; ready: boolean }) => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const wrapper: FC<{ children: ReactNode }> = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(({ backfilling, ready }) => useStaleAfterBackfill(backfilling, KEY, ready), { initialProps: initial, wrapper });

    return { ...view, invalidate };
};

describe("useStaleAfterBackfill", () => {
    it("marks the query stale once, when the backfill finishes", () => {
        const { invalidate, rerender } = setup({ backfilling: true, ready: true });

        expect(invalidate).not.toHaveBeenCalled();

        rerender({ backfilling: false, ready: true });
        rerender({ backfilling: false, ready: true });

        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    });

    it("does nothing while the query's inputs are not ready, or when no backfill ran", () => {
        const waiting = setup({ backfilling: true, ready: false });

        waiting.rerender({ backfilling: false, ready: false });

        expect(waiting.invalidate).not.toHaveBeenCalled();

        const done = setup({ backfilling: false, ready: true });

        done.rerender({ backfilling: false, ready: true });

        expect(done.invalidate).not.toHaveBeenCalled();
    });
});
