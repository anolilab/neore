/**
 * The runner a project remembers, so a new thread in it starts on the computer and agent its last host thread used
 * (plan C5). A personal project keeps it on its own row; an organization project keeps each person's on their own
 * `userSettings`, so no member reads another's. The folder is kept as its id only: its path never leaves the desktop.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { setProjectRunnerDefault } from "../../agent/table-writes";
import { saveUserSettings } from "../../auth/lib/preference-writes";
import { offerOf } from "./start";

/** The most organization projects one person keeps a default for; the one used longest ago goes first. */
export const MAX_PROJECT_RUNNER_DEFAULTS = 200;

export interface ProjectRunner {
    agentKey: string;
    deviceId: string;
    folderId: string;
}

/** The runner a new thread in `project` starts on by default for the caller, given the caller's settings row (or `null`). */
export const projectRunnerOf = (project: Doc<"projects">, settings: Pick<Doc<"userSettings">, "projectRunnerDefaults"> | null): ProjectRunner | null => {
    if (project.organizationId) {
        const found: ProjectRunner | undefined = settings?.projectRunnerDefaults?.[project._id];

        return found ?? null;
    }

    if (project.runnerKind !== "host" || !project.runnerDeviceId || !project.runnerAgentKey || !project.runnerFolderId) {
        return null;
    }

    return { agentKey: project.runnerAgentKey, deviceId: project.runnerDeviceId, folderId: project.runnerFolderId };
};

/** Whether the computer still is the caller's and paired, and still offers the agent and folder: a stale default is never preselected. */
export const runnerStillOffered = (device: Doc<"devices"> | null, runner: ProjectRunner): boolean =>
    Boolean(device?.encryptedSecret) && offerOf(device, runner.agentKey, runner.folderId) !== undefined;

/**
 * Records the runner a host thread in `project` started on, for the next new thread there. Called inside the start's
 * own mutation, so a start that is refused leaves no default behind.
 */
export const rememberProjectRunner = async (
    ctx: MutationCtx,
    project: Doc<"projects">,
    userId: string,
    organizationId: string | null,
    runner: ProjectRunner,
): Promise<void> => {
    if (!project.organizationId) {
        await setProjectRunnerDefault(ctx.db, project, runner);

        return;
    }

    const settings = await ctx.db.userSettings.findFirst({ where: { userId } });
    // Re-recording a project moves it to the end, so the entries at the front are the ones used longest ago.
    const kept = Object.entries(settings?.projectRunnerDefaults ?? {})
        .filter(([key]) => key !== project._id)
        .slice(-(MAX_PROJECT_RUNNER_DEFAULTS - 1));

    await saveUserSettings(ctx.db, settings, userId, { projectRunnerDefaults: { ...Object.fromEntries(kept), [project._id]: runner } }, organizationId);
};
