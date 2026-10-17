import { describe, expect, it } from "vitest";

import type { WorkflowEdge, WorkflowNode, WorkflowNodeType } from "../types";
import { mentionableLabels } from "./mention-labels";

const node = (id: string, type: string, label: string) => ({ data: { label }, id, position: { x: 0, y: 0 }, type: type as WorkflowNodeType }) as WorkflowNode;

const nodes = [
    node("tpl", "text", "Template"),
    node("notes", "text", "Notes"),
    node("pic", "image", "Frame"),
    node("dup1", "text", "Summary"),
    node("dup2", "ai", "summary"),
    node("file", "file", "Upload"),
];
const edges = [
    { source: "pic", target: "tpl" },
    { source: "notes", target: "tpl" },
    { source: "dup1", target: "tpl" },
    { source: "dup2", target: "tpl" },
    { source: "file", target: "tpl" },
] as WorkflowEdge[];

describe("mentionableLabels", () => {
    it("offers the direct upstream text nodes in edge order, hiding ambiguous labels and other node kinds", () => {
        expect(mentionableLabels(nodes, edges, "tpl")).toStrictEqual(["Notes"]);
    });

    it("offers image nodes as well when asked for image mentions", () => {
        expect(mentionableLabels(nodes, edges, "tpl", ["text", "image"])).toStrictEqual(["Frame", "Notes"]);
    });
});
