import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useUnloadGuard } from "./use-unload-guard";

const isGuarded = (): boolean => {
    const event = new Event("beforeunload", { cancelable: true });

    globalThis.dispatchEvent(event);

    return event.defaultPrevented;
};

describe(useUnloadGuard, () => {
    it("guards while active, and releases when it ends or the component unmounts", () => {
        const { rerender, unmount } = renderHook(({ active }) => useUnloadGuard(active), { initialProps: { active: false } });

        expect(isGuarded()).toBe(false);

        rerender({ active: true });

        expect(isGuarded()).toBe(true);

        rerender({ active: false });

        expect(isGuarded()).toBe(false);

        rerender({ active: true });
        unmount();

        expect(isGuarded()).toBe(false);
    });
});
