/**
 * The runner a project remembers, so a new thread in it starts on the computer and agent its last host thread used
 * (plan C5). A personal project keeps it on its own row; an organization project keeps each person's on their own
 * `userSettings`, so no member reads another's. The folder is kept as its id only: its path never leaves the desktop.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { setProjectRunnerDefault } from "../../agent/table-writes";
import { saveUserSettings } from "../../auth/lib/preference-writes";
import { systemDb } from "../../lib/rls/scope";
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

/** Projects read per query by {@link liveProjectEntries}: D1 binds at most 100 parameters a statement. */
const PROJECTS_PER_READ = 90;

/** The entries whose project still exists, in their order. A project that was deleted is not kept. */
const liveProjectEntries = async <T>(ctx: MutationCtx, entries: [string, T][]): Promise<[string, T][]> => {
    const ids = entries.map(([key]) => ctx.db.normalizeId("projects", key)).filter((id) => id !== null);
    const live = new Set<string>();

    for (let start = 0; start < ids.length; start += PROJECTS_PER_READ) {
        // Past RLS: an organization project is not visible to the starter from another space.
        const { page } = await systemDb(ctx).projects.findMany({ where: { _id: { in: ids.slice(start, start + PROJECTS_PER_READ) } } });

        for (const row of page) {
            live.add(row._id);
        }
    }

    return entries.filter(([key]) => live.has(key));
};

/**
 * Records the runner of a start the computer's agent has opened, for the project its thread is in (none when the project is gone).
 * Called where the session turns idle, so a start the computer refused or never opened leaves the default it had.
 */
export const rememberOpenedRunner = async (ctx: MutationCtx, projectId: Id<"projects">, session: Doc<"acpSessions">): Promise<void> => {
    const project = await systemDb(ctx).projects.findFirst({ where: { _id: projectId } });

    if (!project) {
        return;
    }

    await rememberProjectRunner(ctx, project, session.userId, project.organizationId ?? null, {
        agentKey: session.agentKey,
        deviceId: session.deviceId as string,
        folderId: session.folderId,
    });
};

/** Records the runner a host thread in `project` started on, for the next new thread there. */
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
    const others = Object.entries(settings?.projectRunnerDefaults ?? {}).filter(([key]) => key !== project._id);
    // At the cap, the entries of deleted projects go first, so they never push out a default that still applies.
    const live = others.length < MAX_PROJECT_RUNNER_DEFAULTS ? others : await liveProjectEntries(ctx, others);
    const kept = live.slice(-(MAX_PROJECT_RUNNER_DEFAULTS - 1));

    await saveUserSettings(ctx.db, settings, userId, { projectRunnerDefaults: { ...Object.fromEntries(kept), [project._id]: runner } }, organizationId);
};
