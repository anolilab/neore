import { describe, expect, it } from "vitest";

import { toolImageSource } from "./tool-image-source";

describe(toolImageSource, () => {
    it("turns inline base64 into a data URL", () => {
        expect(toolImageSource({ inline: "iVBORw0KGgo=", mediaType: "image/png" })).toBe("data:image/png;base64,iVBORw0KGgo=");
    });

    it("uses the signed link the server wrote for stored bytes", () => {
        const url = "https://api.example.com/agent-files/abc?exp=1&method=GET&bucket=files&sig=x";

        expect(toolImageSource({ inline: "", mediaType: "image/png", url })).toBe(url);
    });

    it("never turns the inline field into a link, even when a tool put a URL there", () => {
        expect(toolImageSource({ inline: "https://tracker.example/p.png", mediaType: "image/png" })).toBe(
            "data:image/png;base64,https://tracker.example/p.png",
        );
    });

    it("shows nothing for a reference that was not signed or a dropped image", () => {
        expect(toolImageSource({ inline: "", mediaType: "image/png", url: "" })).toBeUndefined();
        expect(toolImageSource({ mediaType: "image/png", url: "storage:agent-files/abc" })).toBeUndefined();
        expect(toolImageSource({ inline: "", mediaType: "image/png" })).toBeUndefined();
    });
});
