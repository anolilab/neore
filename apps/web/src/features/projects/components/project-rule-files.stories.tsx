import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraAnswered, lunoraHandlers } from "@/storybook/lunora";

import ProjectRuleFiles from "./project-rule-files";

const FILES = [
    { content: "Answer in short paragraphs.", id: "style", mode: "always" as const, title: "Style" },
    { content: "Use snake_case columns.", globs: ["**/*.sql"], id: "sql", mode: "glob" as const, title: "SQL" },
    { content: "Run the deploy script, then check the logs.", description: "How we deploy a release", id: "deploy", mode: "auto" as const, title: "Deploy" },
];

const ruleFiles = (canEdit: boolean) => lunora(api.projects.functions.listProjectRuleFiles, { canEdit, files: FILES, revision: "r1" });

const meta = {
    args: { projectId: "project-1" },
    component: ProjectRuleFiles,
    decorators: [
        (Story) => (
            <div className="w-[40rem] max-w-full">
                <Story />
            </div>
        ),
    ],
    parameters: { layout: "padded", msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ruleFiles(true)) } } },
    title: "Projects/Rule files",
} satisfies Meta<typeof ProjectRuleFiles>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The owner's editor with a file read when needed: its line saying when to read it shows under its mode. */
export const WithFileReadWhenNeeded: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const deploy = within(await canvas.findByRole("listitem", { name: "Deploy" }));

        await expect(deploy.getByRole("radio", { name: "When needed" })).toBeChecked();
        await expect(deploy.getByRole("textbox", { name: "When to read it" })).toHaveValue("How we deploy a release");
        await expect(canvas.getByRole("button", { name: "Import files" })).toBeEnabled();
        await expect(canvas.getByRole("button", { name: "Import rule folder" })).toBeEnabled();
    },
};

/** A file read when needed without its line: the save is refused and the field marked. */
export const FileReadWhenNeededWithoutDescription: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const deploy = within(await canvas.findByRole("listitem", { name: "Deploy" }));
        const description = deploy.getByRole("textbox", { name: "When to read it" });

        await userEvent.clear(description);
        await userEvent.click(canvas.getByRole("button", { name: "Save rule files" }));

        await expect(await canvas.findByRole("alert")).toHaveTextContent("A file read when needed needs a line saying when to read it.");
        await expect(description).toHaveAttribute("aria-invalid", "true");
    },
};

/** An uploaded AGENTS.md lands as one always file, unsaved until the owner saves. */
export const ImportedAgentsFile: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await lunoraAnswered(api.projects.functions.listProjectRuleFiles);
        await canvas.findByRole("listitem", { name: "Style" });
        await userEvent.upload(canvas.getByTestId("rule-file-import"), new File(["# Agents\n\nRun the tests first."], "AGENTS.md", { type: "text/markdown" }));

        const imported = within(await canvas.findByRole("listitem", { name: "AGENTS.md" }));

        await expect(imported.getByRole("radio", { name: "Always" })).toBeChecked();
        await expect(canvas.getByText("1 rule file imported. Review, then save.")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Save rule files" })).toBeEnabled();
    },
};

/** A member who may not edit: each file's mode, and a file read when needed with its line. */
export const ReadOnly: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ruleFiles(false)) } } },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(await canvas.findByText("How we deploy a release")).toBeVisible();
        await expect(canvas.getByText("When needed")).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Import files" })).toBeNull();
    },
};
