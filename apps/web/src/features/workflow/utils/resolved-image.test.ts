import { describe, expect, it } from "vitest";

import type { WorkflowNode } from "../types";
import { stripResolvedImageUrl } from "./resolved-image";

const imageNode = (data: Record<string, unknown>): WorkflowNode => ({ data, id: "n1", position: { x: 0, y: 0 }, type: "image" }) as unknown as WorkflowNode;

describe("stripResolvedImageUrl", () => {
    it("drops the resolved URL of a file-backed image and keeps the reference", () => {
        const node = imageNode({ imageFileId: "f1", imageUrl: "https://signed.example/x", mode: "input" });

        const stripped = stripResolvedImageUrl(node);

        expect((stripped.data as { imageFileId?: string }).imageFileId).toBe("f1");
        expect((stripped.data as { imageUrl?: string }).imageUrl).toBeUndefined();
    });

    it("leaves an inline image untouched", () => {
        const node = imageNode({ imageUrl: "data:image/png;base64,AAAA", mode: "input" });

        expect(stripResolvedImageUrl(node)).toBe(node);
    });
});
