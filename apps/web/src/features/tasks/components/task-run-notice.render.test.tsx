/**
 * A run that could not go where the task says (a locked chat, a project the owner can no longer file into) says why.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TaskRunNotice from "./task-run-notice";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { i18n: { date: (date: Date) => date.toISOString() }, t: text };
        },
    };
});

describe("TaskRunNotice", () => {
    it("says a run started a new chat because the one it continues is locked", () => {
        render(
            <dl>
                <TaskRunNotice notice={{ at: Date.UTC(2026, 10, 6, 9), reason: "thread_locked" }} />
            </dl>,
        );

        expect(screen.getByText("started a new chat: the one it continues is locked", { exact: false })).toBeTruthy();
    });

    it("says a run was filed in no project because the owner can no longer add chats to it", () => {
        render(
            <dl>
                <TaskRunNotice notice={{ at: Date.UTC(2026, 10, 6, 9), reason: "project_unwritable" }} />
            </dl>,
        );

        expect(screen.getByText("filed in no project", { exact: false })).toBeTruthy();
    });
});
