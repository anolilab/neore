/**
 * Every control inside a workflow node is named by the visible label above it, so a screen reader says what a select,
 * switch or slider changes. A `Label` that points at nothing leaves the control with no name.
 */

import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";

import AdvancedControlsNode from "./advanced-controls-node";
import AudioNode from "./audio-node";
import BackgroundRemovalNode from "./background-removal-node";
import CharacterRefNode from "./character-ref-node";
import CodeNode from "./code-node";
import ControlNetNode from "./controlnet-node";
import ImageNode from "./image-node";
import ImageToVideoNode from "./image-to-video-node";
import Img2ImgNode from "./img2img-node";
import ObjectEditorNode from "./object-editor-node";
import OutpaintNode from "./outpaint-node";
import ParallelCompareNode from "./parallel-compare-node";
import TranscriptionNode from "./transcription-node";
import UpscaleNode from "./upscale-node";
import VideoNode from "./video-node";

// A node's model hooks reach the auth server module, which reads the backend URL when it loads.
vi.hoisted(() => {
    vi.stubEnv("VITE_LUNORA_URL", "https://backend.example.test");
});

vi.mock("@/lib/env", () => {
    return {
        default: {
            VITE_LLM_GATEWAY_URL: "https://gateway.example.test",
            VITE_LUNORA_URL: "https://backend.example.test",
            VITE_SITE_URL: "https://app.example.test",
        },
    };
});

// Unit tests do not compile the Lingui macros: a template reads as its own text, a message descriptor as its id.
vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings[0] };
        },
    };
});
vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});
// The shell around a node needs the canvas and the collaboration context; only its children are under test.
vi.mock("./base-node", () => {
    return { default: ({ children }: { children: unknown }) => children };
});
vi.mock("./video-frames-section", () => {
    return { VideoFramesSection: () => null };
});
vi.mock("./mask-section", () => {
    return { default: () => null };
});
vi.mock("../codemirror-compact", () => {
    return { default: ({ ariaLabelledBy }: { ariaLabelledBy?: string }) => <div aria-labelledby={ariaLabelledBy} role="textbox" /> };
});

type Role = "combobox" | "slider" | "switch" | "textbox";

const CASES: { component: ComponentType<never>; controls: [Role, string | RegExp][]; data: Record<string, string>; name: string }[] = [
    {
        component: CodeNode,
        controls: [
            ["combobox", "Language"],
            ["textbox", "Code"],
        ],
        data: { code: "", language: "javascript" },
        name: "code",
    },
    { component: TranscriptionNode, controls: [["combobox", "Language"]], data: {}, name: "transcription" },
    { component: AudioNode, controls: [["combobox", "Voice"]], data: {}, name: "audio" },
    { component: ImageNode, controls: [["combobox", "Mode"]], data: { mode: "input" }, name: "image" },
    {
        component: UpscaleNode,
        controls: [
            ["combobox", "Scale Factor"],
            ["switch", "Enhance Details"],
        ],
        data: {},
        name: "upscale",
    },
    {
        component: VideoNode,
        controls: [
            ["combobox", "Mode"],
            ["combobox", "Aspect Ratio"],
            ["combobox", "FPS"],
            ["slider", "Duration: 5s"],
        ],
        data: { mode: "text-to-video" },
        name: "video",
    },
    {
        component: ImageToVideoNode,
        controls: [
            ["combobox", "FPS"],
            ["slider", "Duration: 5s"],
            ["slider", "Motion: 50%"],
        ],
        data: {},
        name: "image-to-video",
    },
    {
        component: OutpaintNode,
        controls: [
            ["combobox", "Direction"],
            ["slider", "Expand: 256px"],
        ],
        data: {},
        name: "outpaint",
    },
    { component: Img2ImgNode, controls: [["slider", "Strength"]], data: {}, name: "img2img" },
    {
        component: ControlNetNode,
        controls: [
            ["combobox", "Control Type"],
            ["slider", "Control Strength"],
        ],
        data: { controlType: "canny" },
        name: "controlnet",
    },
    {
        component: AdvancedControlsNode,
        controls: [
            ["combobox", "Sampler"],
            ["combobox", "Scheduler"],
            ["slider", "CFG Scale"],
            ["slider", "Steps"],
            ["slider", "CLIP Skip"],
        ],
        data: {},
        name: "advanced-controls",
    },
    { component: BackgroundRemovalNode, controls: [["combobox", "Output Format"]], data: {}, name: "background-removal" },
    {
        component: CharacterRefNode,
        controls: [
            ["combobox", "Reference Mode"],
            ["textbox", /Reference Images/u],
            ["slider", "Reference Strength"],
        ],
        data: {},
        name: "character-ref",
    },
    { component: ObjectEditorNode, controls: [["combobox", "Edit Mode"]], data: { mode: "replace" }, name: "object-editor" },
    { component: ParallelCompareNode, controls: [["switch", "Show Labels"]], data: {}, name: "parallel-compare" },
];

describe("workflow node controls", () => {
    it.each(CASES)("names the controls of the $name node by their visible label", ({ component: Component, controls, data }) => {
        const Node = Component as ComponentType<{ data: Record<string, string>; id: string; selected: boolean }>;

        render(<Node data={data} id="node-1" selected={false} />);

        // A slider's thumb stays `visibility: hidden` until the canvas measures it, which jsdom never does, and a hidden
        // element has no computed name: its `aria-label` is read off the range input instead.
        const thumbLabels = screen.queryAllByRole("slider", { hidden: true }).map((thumb) => thumb.getAttribute("aria-label"));

        for (const [role, name] of controls) {
            if (role === "slider") {
                expect(thumbLabels, `slider "${String(name)}"`).toContain(name);
            } else {
                expect(screen.getByRole(role, { name }), `${role} "${String(name)}"`).toBeTruthy();
            }
        }
    });
});
