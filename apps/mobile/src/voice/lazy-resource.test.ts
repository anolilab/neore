import { describe, expect, it, vi } from "vitest";

import { createLazyResource } from "./lazy-resource";

const recorders = () => {
    let made = 0;
    const create = vi.fn(() => {
        made += 1;

        return { id: made };
    });
    const dispose = vi.fn();

    return { create, dispose, resource: createLazyResource(create, dispose) };
};

describe(createLazyResource, () => {
    it("makes nothing until it is first needed: opening a chat creates no recorder", () => {
        const { create, dispose, resource } = recorders();

        expect(resource.peek()).toBeUndefined();

        resource.release();

        expect(create).not.toHaveBeenCalled();
        expect(dispose).not.toHaveBeenCalled();
    });

    it("makes one recorder on the first press and reuses it for the next", () => {
        const { create, resource } = recorders();

        const first = resource.get();

        expect(resource.get()).toBe(first);
        expect(resource.peek()).toBe(first);
        expect(create).toHaveBeenCalledOnce();
    });

    it("releases what it made once, still lets a late stop reach it, and makes a new one after", () => {
        const { create, dispose, resource } = recorders();
        const first = resource.get();

        resource.release();
        resource.release();

        expect(dispose).toHaveBeenCalledExactlyOnceWith(first);
        expect(resource.peek()).toBe(first);

        const second = resource.get();

        expect(second).not.toBe(first);
        expect(create).toHaveBeenCalledTimes(2);
    });
});
