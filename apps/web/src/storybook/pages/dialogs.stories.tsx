import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RouteComponent } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useState } from "react";
import { expect, screen, waitFor } from "storybook/test";

import CaseFormDialog from "@/features/evals/components/case-form-dialog";
import DatasetFormDialog from "@/features/evals/components/dataset-form-dialog";
import ImportCasesDialog from "@/features/evals/components/import-cases-dialog";
import RunDialog from "@/features/evals/components/run-dialog";
import AddProjectDialog from "@/features/projects/components/add-project-dialog";
import MoveToProjectDialog from "@/features/projects/components/move-to-project-dialog";
import ProjectFormDialog from "@/features/projects/components/project-form-dialog";
import PromptFormDialog from "@/features/prompts/components/prompt-form-dialog";
import PromptHistoryDialog from "@/features/prompts/components/prompt-history-dialog";
import PromptOptimizeDialog from "@/features/prompts/components/prompt-optimize-dialog";
import VariableFillDialog from "@/features/prompts/components/variable-fill-dialog";
import BundleExportDialog from "@/features/skills/components/bundle-export-dialog";
import BundleImportDialog from "@/features/skills/components/bundle-import-dialog";
import MarketplaceSkillDetailDialog from "@/features/skills/components/marketplace-skill-detail-dialog";
import SkillBuilderDialog from "@/features/skills/components/skill-builder-dialog";
import SkillFormDialog from "@/features/skills/components/skill-form-dialog";
import SkillImportDialog from "@/features/skills/components/skill-import-dialog";
import GoalFormDialog from "@/features/tasks/components/goal-form-dialog";
import TaskDetailDialog from "@/features/tasks/components/task-detail-dialog";
import TaskFormDialog from "@/features/tasks/components/task-form-dialog";
import { chatFixtures } from "@/storybook/fixtures/chat";
import {
    DATASETS,
    evalsFixtures,
    MARKETPLACE,
    projectFormFixtures,
    PROMPTS,
    promptsFixtures,
    SKILLS,
    skillsFixtures,
    TASK_BOARD,
    tasksFixtures,
} from "@/storybook/fixtures/library";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraError, lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";
import { pressable } from "@/storybook/play";

// A dialog loads its chunk, then its data; with four browser projects running at once that can outlast a few seconds.
const WAIT = { timeout: 15_000 } as const;

const handlers = (...fixtures: ReturnType<typeof userFixtures>) => {
    return { gateway: gatewayModelsHandler(), lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...fixtures) };
};

/**
 * The dialogs of the Skills, Prompts, Evals, Tasks and Projects pages, each rendered open over an empty page with the data
 * it reads. A `Validation` story submits the empty form, so its field errors show.
 */
const meta = {
    args: { levels: [], url: "/" },
    component: StoryPage,
    parameters: { layout: "fullscreen", msw: { handlers: handlers() } },
    title: "Pages/Dialogs",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

const noop = () => {};

const noopAsync = async () => {};

const levelsOf = (component: RouteComponent) => [{ component, path: "/" }] as const;

const dialog = async (name: RegExp | string) => {
    const found = await screen.findByRole("dialog", { name }, WAIT);

    await expect(found).toBeVisible();

    return found;
};

// Skills

const SkillFormNew = () => <SkillFormDialog canShareWithOrganization isOwner onClose={noop} onSubmit={noopAsync} open />;
const SkillFormEdit = () => <SkillFormDialog canShareWithOrganization editingSkill={SKILLS[0] as never} isOwner onClose={noop} onSubmit={noopAsync} open />;
const SkillImport = () => <SkillImportDialog onClose={noop} onImported={noop} open />;
const BundleImport = () => <BundleImportDialog onClose={noop} onImported={noop} open />;
const BundleExport = () => <BundleExportDialog onClose={noop} open />;
const MarketplaceDetail = () => <MarketplaceSkillDetailDialog onClose={noop} skillId={MARKETPLACE[0]!._id} />;
const SkillBuilder = () => <SkillBuilderDialog onClose={noop} onSaved={noop} onUseMarketplaceSkill={noop} open />;

export const SkillForm: Story = {
    args: { levels: levelsOf(SkillFormNew) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async () => {
        await expect(await dialog("Create skill")).toBeVisible();
    },
};

export const SkillFormEditing: Story = {
    args: { levels: levelsOf(SkillFormEdit) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async () => {
        await expect(await dialog("Edit skill")).toBeVisible();
    },
};

export const SkillImportOpen: Story = {
    args: { levels: levelsOf(SkillImport) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async () => {
        await dialog(/import/iu);
    },
};

export const BundleImportOpen: Story = {
    args: { levels: levelsOf(BundleImport) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async () => {
        await dialog(/import/iu);
    },
};

export const BundleExportOpen: Story = {
    args: { levels: levelsOf(BundleExport) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async () => {
        await dialog(/export/iu);
    },
};

export const MarketplaceSkillDetail: Story = {
    args: { levels: levelsOf(MarketplaceDetail) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async () => {
        await dialog("Meeting minutes");
    },
};

export const MarketplaceSkillDetailError: Story = {
    args: { levels: levelsOf(MarketplaceDetail) },
    parameters: {
        msw: {
            handlers: handlers(...skillsFixtures(), lunoraError(api.skills.marketplace.getSkillDetail, "NOT_FOUND", "This skill is no longer available.", 404)),
        },
    },
    play: async () => {
        await dialog(/skill details/iu);
        await expect(await screen.findByRole("alert", undefined, WAIT)).toBeVisible();
    },
};

export const SkillBuilderGoal: Story = {
    args: { levels: levelsOf(SkillBuilder) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async () => {
        await dialog("Agent builder");
    },
};

export const SkillBuilderReview: Story = {
    args: { levels: levelsOf(SkillBuilder) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async ({ userEvent }) => {
        await dialog("Agent builder");
        await userEvent.type(
            await screen.findByLabelText("What should the agent do?", undefined, WAIT),
            "Every Monday, summarise new GitHub issues in my repo",
        );
        await userEvent.click(await pressable(screen, "Continue"));
        await expect(await screen.findByRole("heading", { name: "Draft" }, WAIT)).toBeVisible();
    },
};

export const SkillBuilderRefined: Story = {
    args: { levels: levelsOf(SkillBuilder) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async ({ userEvent }) => {
        await dialog("Agent builder");
        await userEvent.type(
            await screen.findByLabelText("What should the agent do?", undefined, WAIT),
            "Every Monday, summarise new GitHub issues in my repo",
        );
        await userEvent.click(await pressable(screen, "Continue"));
        const change = await screen.findByLabelText("What should change?", undefined, WAIT);

        // The review step grows the dialog as it appears; a click on the field while it moves can miss it, so type until it holds the text.
        await waitFor(
            async () => {
                await userEvent.clear(change);
                await userEvent.type(change, "Keep it under ten lines");
                await expect(change).toHaveValue("Keep it under ten lines");
            },
            { timeout: 10_000 },
        );
        await userEvent.click(await pressable(screen, "Refine"));
        await expect(await screen.findByRole("list", { name: "Changes from the last refinement" }, WAIT)).toBeVisible();
    },
};

export const SkillImportPreview: Story = {
    args: { levels: levelsOf(SkillImport) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async ({ userEvent }) => {
        await dialog("Import skill");
        const markdown = await screen.findByLabelText("SKILL.md", undefined, WAIT);

        await userEvent.click(markdown);
        await userEvent.paste(
            "---\nname: release-notes\ndescription: Draft release notes from merged pull requests.\n---\n\nList the merged pull requests and group them by label.",
        );
        await expect(await screen.findByText("/release-notes", undefined, WAIT)).toBeVisible();
    },
};

export const BundleImportReview: Story = {
    args: { levels: levelsOf(BundleImport) },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async ({ userEvent }) => {
        const found = await dialog("Import a bundle");
        const input = found.querySelector<HTMLInputElement>("input[type=file]");

        await expect(input).not.toBeNull();
        await userEvent.upload(input!, new File(["# Support team bundle"], "support-team.md", { type: "text/markdown" }));
        await expect(await screen.findByText("This bundle came from someone else", undefined, WAIT)).toBeVisible();
    },
};

// Prompts

const PROMPT = PROMPTS[0] as never;

const PromptFormNew = () => <PromptFormDialog onClose={noop} onSubmit={noopAsync} open />;
const PromptFormEdit = () => <PromptFormDialog editingPrompt={PROMPT} onClose={noop} onSubmit={noopAsync} open />;
const PromptHistory = () => <PromptHistoryDialog onClose={noop} open prompt={PROMPT} />;
const PromptOptimize = () => <PromptOptimizeDialog onClose={noop} onOptimized={noopAsync} open prompt={PROMPT} />;
const VariableFill = () => <VariableFillDialog existingValues={{}} onCancel={noop} onUse={noop} onUseAnyway={noop} open prompt={PROMPT} />;

const REQUIRED_VARIABLES_PROMPT = {
    ...PROMPTS[0],
    variables: [
        { description: "Who will read the result", name: "audience", required: true },
        { description: "The draft to edit", name: "text", required: true },
    ],
} as never;

const VariableFillRequired = () => (
    <VariableFillDialog existingValues={{}} onCancel={noop} onUse={noop} onUseAnyway={noop} open prompt={REQUIRED_VARIABLES_PROMPT} />
);

export const PromptForm: Story = {
    args: { levels: levelsOf(PromptFormNew) },
    parameters: { msw: { handlers: handlers(...promptsFixtures()) } },
    play: async () => {
        await dialog(/prompt/iu);
    },
};

export const PromptFormEditing: Story = {
    args: { levels: levelsOf(PromptFormEdit) },
    parameters: { msw: { handlers: handlers(...promptsFixtures()) } },
    play: async () => {
        await dialog(/prompt/iu);
    },
};

export const PromptHistoryOpen: Story = {
    args: { levels: levelsOf(PromptHistory) },
    parameters: { msw: { handlers: handlers(...promptsFixtures()) } },
    play: async () => {
        await dialog(/history/iu);
    },
};

export const PromptOptimizeOpen: Story = {
    args: { levels: levelsOf(PromptOptimize) },
    parameters: { msw: { handlers: handlers(...promptsFixtures()) } },
    play: async () => {
        await dialog(/optimi/iu);
    },
};

export const VariableFillOpen: Story = {
    args: { levels: levelsOf(VariableFill) },
    parameters: { msw: { handlers: handlers(...promptsFixtures()) } },
    play: async () => {
        await dialog("Fill Variables");
    },
};

export const VariableFillRequiredMissing: Story = {
    args: { levels: levelsOf(VariableFillRequired) },
    parameters: { msw: { handlers: handlers(...promptsFixtures()) } },
    play: async () => {
        await dialog("Fill Variables");
        await expect(await screen.findByText("Required variables missing", undefined, WAIT)).toBeVisible();
    },
};

export const VariableFillPreview: Story = {
    args: { levels: levelsOf(VariableFillRequired) },
    parameters: { msw: { handlers: handlers(...promptsFixtures()) } },
    play: async ({ userEvent }) => {
        await dialog("Fill Variables");
        await userEvent.type(await screen.findByLabelText(/audience/u, undefined, WAIT), "new hires");
        await userEvent.type(await screen.findByLabelText(/text/u, undefined, WAIT), "Our refund policy is long.");
        await expect(await screen.findByText("Preview", undefined, WAIT)).toBeVisible();
    },
};

// Evals

const DATASET = DATASETS[0]!;

const CASE = {
    _id: "case_1",
    checks: [
        { kind: "contains", value: "30 days" },
        { kind: "max_latency_ms", value: "4000" },
    ],
    createdAt: 0,
    expectedAnswer: "Refunds are possible within 30 days of purchase.",
    expectedSources: [],
    frozen: false,
    input: "Can I get a refund after three weeks?",
    rubric: "Names the receipt requirement.",
    source: "manual",
    updatedAt: 0,
} as never;

const CaseFormEdit = () => <CaseFormDialog editing={CASE} onClose={noop} onSubmit={noopAsync} open rag={false} />;
const CaseFormNew = () => <CaseFormDialog onClose={noop} onSubmit={noopAsync} open rag={false} />;
const DatasetFormEdit = () => <DatasetFormDialog editing={DATASET} onClose={noop} onSubmit={noopAsync} open />;
const DatasetFormNew = () => <DatasetFormDialog onClose={noop} onSubmit={noopAsync} open />;
const ImportCases = () => <ImportCasesDialog datasetId={DATASET._id} onClose={noop} open />;
const Run = () => <RunDialog dataset={DATASET} onClose={noop} onStarted={noop} open />;

export const CaseForm: Story = {
    args: { levels: levelsOf(CaseFormNew) },
    parameters: { msw: { handlers: handlers(...evalsFixtures()) } },
    play: async () => {
        await dialog("New case");
    },
};

export const CaseFormEditing: Story = {
    args: { levels: levelsOf(CaseFormEdit) },
    parameters: { msw: { handlers: handlers(...evalsFixtures()) } },
    play: async () => {
        await dialog("Edit case");
    },
};

export const CaseFormValidation: Story = {
    args: { levels: levelsOf(CaseFormNew) },
    parameters: { msw: { handlers: handlers(...evalsFixtures()) } },
    play: async ({ userEvent }) => {
        await dialog("New case");
        await userEvent.click(await pressable(screen, "Add case"));
        await expect(await screen.findByText("Input is required", undefined, WAIT)).toBeVisible();
    },
};

export const DatasetForm: Story = {
    args: { levels: levelsOf(DatasetFormNew) },
    parameters: { msw: { handlers: handlers(...evalsFixtures()) } },
    play: async () => {
        await dialog("New dataset");
    },
};

export const DatasetFormEditing: Story = {
    args: { levels: levelsOf(DatasetFormEdit) },
    parameters: { msw: { handlers: handlers(...evalsFixtures()) } },
    play: async () => {
        await dialog("Edit dataset");
    },
};

export const DatasetFormValidation: Story = {
    args: { levels: levelsOf(DatasetFormNew) },
    parameters: { msw: { handlers: handlers(...evalsFixtures()) } },
    play: async ({ userEvent }) => {
        await dialog("New dataset");
        await userEvent.click(await pressable(screen, "Create dataset"));
        await expect(await screen.findByText("Name is required", undefined, WAIT)).toBeVisible();
    },
};

export const ImportCasesOpen: Story = {
    args: { levels: levelsOf(ImportCases) },
    parameters: { msw: { handlers: handlers(...evalsFixtures()) } },
    play: async () => {
        await dialog("Import cases");
    },
};

export const RunOpen: Story = {
    args: { levels: levelsOf(Run) },
    parameters: { msw: { handlers: handlers(...evalsFixtures(), ...tasksFixtures()) } },
    play: async () => {
        await dialog(/Run/u);
    },
};

// Tasks

const GoalFormEdit = () => <GoalFormDialog editingGoal={TASK_BOARD.goals[0]} onClose={noop} onSubmit={noopAsync} open />;
const GoalFormNew = () => <GoalFormDialog onClose={noop} onSubmit={noopAsync} open />;
const TaskFormEdit = () => (
    <TaskFormDialog editingTask={TASK_BOARD.tasks[0]} goals={TASK_BOARD.goals} onClose={noop} onSubmit={noopAsync} open tasks={TASK_BOARD.tasks} />
);
const TaskFormNew = () => <TaskFormDialog goals={TASK_BOARD.goals} onClose={noop} onSubmit={noopAsync} open tasks={TASK_BOARD.tasks} />;
const TaskDetail = () => <TaskDetailDialog onClose={noop} task={TASK_BOARD.tasks[0] as never} />;

export const GoalForm: Story = {
    args: { levels: levelsOf(GoalFormNew) },
    parameters: { msw: { handlers: handlers(...tasksFixtures()) } },
    play: async () => {
        await dialog(/goal/iu);
    },
};

export const GoalFormEditing: Story = {
    args: { levels: levelsOf(GoalFormEdit) },
    parameters: { msw: { handlers: handlers(...tasksFixtures()) } },
    play: async () => {
        await dialog("Edit goal");
    },
};

export const GoalFormValidation: Story = {
    args: { levels: levelsOf(GoalFormNew) },
    parameters: { msw: { handlers: handlers(...tasksFixtures()) } },
    play: async ({ userEvent }) => {
        await dialog(/goal/iu);
        await userEvent.click(await pressable(screen, "Create goal"));
        await expect(await screen.findByText("Title is required", undefined, WAIT)).toBeVisible();
    },
};

export const TaskForm: Story = {
    args: { levels: levelsOf(TaskFormNew) },
    parameters: { msw: { handlers: handlers(...tasksFixtures()) } },
    play: async () => {
        await dialog(/task/iu);
    },
};

export const TaskFormEditing: Story = {
    args: { levels: levelsOf(TaskFormEdit) },
    parameters: { msw: { handlers: handlers(...tasksFixtures()) } },
    play: async () => {
        await dialog("Edit task");
    },
};

export const TaskDetailOpen: Story = {
    args: { levels: levelsOf(TaskDetail) },
    parameters: { msw: { handlers: handlers(...tasksFixtures()) } },
    play: async () => {
        await dialog("Review the pricing page copy");
    },
};

// Projects

const AddProject = () => <AddProjectDialog onClose={noop} onCreateNew={noop} open />;
const ProjectFormNew = () => <ProjectFormDialog onClose={noop} open />;
const ProjectFormEdit = () => (
    <ProjectFormDialog
        editingProject={{
            _id: "project_1",
            color: "#6366f1",
            context: "Always answer in British English.",
            description: "The storefront rebuild",
            title: "Storefront",
        }}
        onClose={noop}
        open
    />
);
const MoveToProject = () => <MoveToProjectDialog onClose={noop} open threadId="thread_1" />;

export const AddProjectOpen: Story = {
    args: { levels: levelsOf(AddProject) },
    parameters: { msw: { handlers: handlers() } },
    play: async () => {
        await dialog(/project/iu);
    },
};

/** The desktop shell's machine picker, stubbed on `globalThis.neoreNative` for the story that shows the machine list. */
const MACHINES = [
    {
        disabledReason: null,
        id: "device_1",
        kind: "this-computer",
        label: "This computer",
        name: "Studio MacBook",
        spec: null,
        sshAlias: null,
        status: "this-computer",
    },
    { disabledReason: null, id: "device_2", kind: "server", label: "Connected", name: "build-box", spec: null, sshAlias: "build-box", status: "connected" },
    { disabledReason: null, id: null, kind: "server", label: "SSH", name: "staging", spec: null, sshAlias: "staging", status: "not-connected" },
    {
        disabledReason: "Needs a newer shell on that machine.",
        id: null,
        kind: "server",
        label: "SSH",
        name: "old-nas",
        spec: null,
        sshAlias: "old-nas",
        status: "disabled",
    },
];

const FOLDERS = {
    entries: [{ name: "storefront" }, { name: "docs-site" }, { name: "dotfiles" }],
    host: "Studio MacBook",
    next: null,
    parent: "/Users/dani",
    path: "/Users/dani/Projects",
};

const DESKTOP_BRIDGE = {
    device: {
        browseMachineFolders: async () => FOLDERS,
        connectAddProjectMachine: async () => MACHINES[1],
        createMachineFolder: async () => {
            return { created: true, path: FOLDERS.path };
        },
        listAddProjectMachines: async () => MACHINES,
        shareMachineFolder: async () => undefined,
    },
    notify: noop,
    onCompose: () => noop,
    takePendingCompose: async () => null,
};

/** Installs the stub before the first render (the dialog reads it while rendering) and removes it on unmount. */
const DesktopBridge = ({ children }: { children: ReactNode }) => {
    useState(() => {
        Object.defineProperty(globalThis, "neoreNative", { configurable: true, value: DESKTOP_BRIDGE });
    });

    useEffect(
        () => () => {
            Reflect.deleteProperty(globalThis, "neoreNative");
        },
        [],
    );

    return children;
};

const withDesktopBridge = (Story: ComponentType) => (
    <DesktopBridge>
        <Story />
    </DesktopBridge>
);

export const AddProjectMachines: Story = {
    args: { levels: levelsOf(AddProject) },
    decorators: [withDesktopBridge],
    parameters: { msw: { handlers: handlers() } },
    play: async () => {
        await dialog("Where is the project?");
        await expect(await screen.findByText("build-box", undefined, WAIT)).toBeVisible();
    },
};

export const AddProjectFolders: Story = {
    args: { levels: levelsOf(AddProject) },
    decorators: [withDesktopBridge],
    parameters: { msw: { handlers: handlers() } },
    play: async ({ userEvent }) => {
        await dialog("Where is the project?");
        await userEvent.click(await screen.findByRole("button", { name: /This computer/u }, WAIT));
        await expect(await screen.findByText("storefront", undefined, WAIT)).toBeVisible();
    },
};

export const ProjectFormOpen: Story = {
    args: { levels: levelsOf(ProjectFormNew) },
    parameters: { msw: { handlers: handlers() } },
    play: async () => {
        await dialog(/project/iu);
    },
};

export const ProjectFormEditing: Story = {
    args: { levels: levelsOf(ProjectFormEdit) },
    parameters: { msw: { handlers: handlers(...projectFormFixtures()) } },
    play: async () => {
        await dialog(/project/iu);
    },
};

export const MoveToProjectOpen: Story = {
    args: { levels: levelsOf(MoveToProject) },
    parameters: { msw: { handlers: handlers() } },
    play: async () => {
        await dialog(/move/iu);
    },
};
