// @vitest-environment jsdom

import type { CapabilityReport } from "@neore/ai/capabilities";
import { CLOUD_HEADLESS_CAPABILITIES, CLOUD_INTERACTIVE_CAPABILITIES, followUpControl, LOCAL_BROWSER_CAPABILITIES } from "@neore/ai/capabilities";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ComposerInputArea from "./composer-input-area";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("./composer-tiptap/composer-tiptap-editor", () => {
    return {
        ComposerTiptapEditor: () => <div data-testid="editor" />,
    };
});

const report = (groups: CapabilityReport["groups"]): CapabilityReport => {
    return { groups, reportedAt: 1, version: 1 };
};

const renderArea = (candidate: Parameters<typeof followUpControl>[0] | undefined) => {
    render(
        <ComposerInputArea
            canQueueWhileStreaming
            followUp={candidate === undefined ? undefined : followUpControl(candidate)}
            isStreaming
            onChange={() => {}}
            onSteer={() => {}}
            onSubmit={() => {}}
            value="one more thing"
        />,
    );
};

describe("steer control", () => {
    it("is shown for a runner that steers natively", () => {
        renderArea(CLOUD_INTERACTIVE_CAPABILITIES);

        expect(screen.getByRole("button", { name: "Steer the reply" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Interrupt and restart" })).toBeNull();
    });

    it("is labelled 'interrupt and restart' for a steer that has to restart the run", () => {
        renderArea(report({ turns: { followUp: { degradation: "restart", kind: "steer" } } }));

        expect(screen.getByRole("button", { name: "Interrupt and restart" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Steer the reply" })).toBeNull();
    });

    it.each([
        ["no report", null],
        ["a report that says nothing", report({})],
        ["a report without turns.followUp", report({ turns: { cancel: { degradation: "none", supported: true } } })],
        ["a runner that only queues", CLOUD_HEADLESS_CAPABILITIES],
        ["a follow-up of none", report({ turns: { followUp: { kind: "none" } } })],
        ["a local model", LOCAL_BROWSER_CAPABILITIES],
    ])("is absent for %s, though the message can still be queued", (_name, candidate) => {
        renderArea(candidate);

        expect(screen.queryByRole("button", { name: "Steer the reply" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Interrupt and restart" })).toBeNull();
        expect(screen.getByRole("button", { name: "Queue message" })).toBeTruthy();
    });

    it("is absent when the caller says nothing about the runner", () => {
        renderArea(undefined);

        expect(screen.queryByRole("button", { name: "Steer the reply" })).toBeNull();
    });
});
