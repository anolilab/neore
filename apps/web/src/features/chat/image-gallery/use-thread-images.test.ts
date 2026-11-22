import { describe, expect, it } from "vitest";

import { galleryMessages } from "./use-thread-images";

const done = { id: "m1", role: "assistant", status: "success" };
const prompt = { id: "m2", role: "user", status: "success" };
const streaming = { id: "m3", role: "assistant", status: "streaming" };

describe(galleryMessages, () => {
    it("leaves out the unfinished reply the message list shows as a placeholder while it streams", () => {
        expect(galleryMessages([done, prompt, streaming], true)).toEqual([done, prompt]);
    });

    it("lists the reply once it is done, and every message when nothing streams", () => {
        expect(galleryMessages([done, prompt, { ...streaming, status: "success" }], true)).toHaveLength(3);
        expect(galleryMessages([done, prompt, streaming], false)).toHaveLength(3);
    });

    it("keeps a last message that is not a reply", () => {
        expect(galleryMessages([done, prompt], true)).toEqual([done, prompt]);
    });
});
