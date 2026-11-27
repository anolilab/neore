// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ThreadContext from "./thread-context";

/** What each query answers, by the name its options carry. A missing name is still loading. */
const answers = vi.hoisted(() => new Map<string, { data?: unknown; isError?: boolean }>());

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { i18n: { locale: "en" }, t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@neore/client-runtime", () => {
    return { useUnlockProof: () => undefined };
});
vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skipToken"),
        useQuery: (options: { name?: string; skip?: boolean }) => {
            const answer = options.skip || options.name === undefined ? undefined : answers.get(options.name);

            return { data: answer?.data, isError: answer?.isError === true, isSuccess: answer !== undefined && answer.isError !== true };
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    const query = (name: string) => {
        return { queryOptions: (args: unknown) => (typeof args === "symbol" ? { skip: true } : { name }) };
    };

    return {
        useCRPC: () => {
            return {
                acp: { functions: { getHostSession: query("hostSession") } },
                chat: { sharing: { getThreadAccess: query("access") } },
                devices: { functions: { listDevices: query("devices") } },
            };
        },
    };
});
vi.mock("@/components/model-picker/utilities", () => {
    return { formatTokenCount: String };
});
vi.mock("@/features/chat/core/hooks/use-thread-usage", () => {
    return { default: () => undefined };
});
vi.mock("@/features/chat/goal/use-thread-goal", () => {
    return { useThreadGoal: () => null };
});
vi.mock("@/features/chat/thread/composer-permission-mode", () => {
    return { useShownPermissionMode: () => undefined };
});
vi.mock("@/features/develop/components/thread-pull-requests", () => {
    return { default: () => <span>linked pull requests</span> };
});
vi.mock("@/features/projects/hooks/use-projects", () => {
    return { useProject: () => undefined };
});
vi.mock("@/hooks/use-cached-model-name", () => {
    return { default: () => undefined };
});

const SESSION = { agentLabel: "Coding agent", deviceId: "d1", folderLabel: "~/work/app" };
const renderBox = () => render(<ThreadContext thread={{ runner: "host" }} threadId="t1" />);

beforeEach(() => {
    answers.clear();
    answers.set("hostSession", { data: SESSION });
});

describe(ThreadContext, () => {
    it("names the paired computer once the device list answers", () => {
        answers.set("devices", { data: [{ _id: "d1", name: "Studio Mac" }] });
        renderBox();

        expect(screen.getByText("Studio Mac")).toBeTruthy();
    });

    it("says the device was removed only once the list has answered without it", () => {
        answers.set("devices", { data: [] });
        renderBox();

        expect(screen.getByText("Device removed")).toBeTruthy();
    });

    it.each([
        ["still loading", undefined],
        ["failed", { isError: true }],
    ])("shows the folder alone while the device list is %s", (_state, answer) => {
        if (answer) {
            answers.set("devices", answer);
        }

        renderBox();

        expect(screen.queryByText("Device removed")).toBeNull();
        expect(screen.getByText(SESSION.folderLabel)).toBeTruthy();
    });

    it("calls a live turn in progress, as it is from the send, before the computer picks it up", () => {
        answers.set("hostSession", { data: { ...SESSION, liveStreamId: "s1" } });
        renderBox();

        expect(screen.getByText("In progress")).toBeTruthy();
        expect(screen.queryByText("Running")).toBeNull();
    });

    it.each([
        ["a shared viewer", { isOwner: false }],
        ["anyone while access loads", undefined],
    ])("has no pull request row for %s", (_who, access) => {
        if (access) {
            answers.set("access", { data: access });
        }

        renderBox();

        expect(screen.queryByText("Pull requests")).toBeNull();
    });

    it("has the pull request row for the owner", () => {
        answers.set("access", { data: { isOwner: true } });
        renderBox();

        expect(screen.getByText("Pull requests")).toBeTruthy();
        expect(screen.getByText("linked pull requests")).toBeTruthy();
    });
});
