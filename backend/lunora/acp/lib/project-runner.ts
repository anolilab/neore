/**
 * The runner a project remembers, so a new thread in it starts on the computer and agent its last host thread used
 * (plan C5). A personal project keeps it on its own row; an organization project keeps each person's on their own
 * `userSettings`, so no member reads another's. The folder is kept as its id only: its path never leaves the desktop.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { setProjectRunnerDefault } from "../../agent/table-writes";
import { getMemberByOrganizationAndUser } from "../../auth/lib/better-auth-queries";
import { saveUserSettings } from "../../auth/lib/preference-writes";
import { isDeviceInScope } from "../../devices/lib/scope";
import { offerOf } from "./start";

/** The most organization projects one person keeps a default for; the one used longest ago goes first. */
export const MAX_PROJECT_RUNNER_DEFAULTS = 200;

export interface ProjectRunner {
    agentKey: string;
    deviceId: string;
    folderId: string;
}

/** A runner as it is stored, with the start time of the thread it came from, so an older thread cannot replace it. */
type StoredRunner = ProjectRunner & { threadAt?: number };

/** The runner a new thread in `project` starts on by default for the caller, given the caller's settings row (or `null`). */
export const projectRunnerOf = (project: Doc<"projects">, settings: Pick<Doc<"userSettings">, "projectRunnerDefaults"> | null): ProjectRunner | null => {
    if (project.organizationId) {
        const found: StoredRunner | undefined = settings?.projectRunnerDefaults?.[project._id];

        // An entry from a thread started before the project last changed organization is from its earlier space: it stays on the
        // person's settings (writing every member's on their own shards at a move is not done), but no longer applies.
        if (!found || (found.threadAt ?? -Infinity) < (project.organizationChangedAt ?? -Infinity)) {
            return null;
        }

        return { agentKey: found.agentKey, deviceId: found.deviceId, folderId: found.folderId };
    }

    if (project.runnerKind !== "host" || !project.runnerDeviceId || !project.runnerAgentKey || !project.runnerFolderId) {
        return null;
    }

    return { agentKey: project.runnerAgentKey, deviceId: project.runnerDeviceId, folderId: project.runnerFolderId };
};

/**
 * Whether the computer still is the caller's and paired, still offers the agent and folder, and may still be used in the project
 * (`devices/lib/scope.ts`): a stale default is never preselected.
 */
export const runnerStillOffered = (device: Doc<"devices"> | null, runner: ProjectRunner, projectId: Id<"projects">): boolean =>
    device !== null && Boolean(device.encryptedSecret) && offerOf(device, runner.agentKey, runner.folderId) !== undefined && isDeviceInScope(device, projectId);

/**
 * The oldest entries whose projects are looked up at the cap. Each project row is read, and charged, whole, so the read is
 * kept to a few rows rather than every entry: the session-open mutation it runs in stays well inside the read limit.
 */
const ENTRIES_CHECKED_AT_CAP = 8;

/** Whether a stored entry would still be returned for `project`: it is an organization project, and the entry is from after its last move. */
const entryApplies = (project: Pick<Doc<"projects">, "organizationChangedAt" | "organizationId">, threadAt: number | undefined): boolean =>
    Boolean(project.organizationId) && (threadAt ?? -Infinity) >= (project.organizationChangedAt ?? -Infinity);

/**
 * The entries with the ones that go to make room for one more: of the oldest few, those that can never be used again (the
 * project was deleted, left its organization or moved after the entry's thread started, the person is no longer its owner or
 * a member of its organization, or the computer is gone or no longer theirs), so they never push out a default that still
 * applies; the oldest one when all of those still can be.
 */
const entriesWithRoom = async (ctx: MutationCtx, userId: string, entries: [string, StoredRunner][]): Promise<[string, StoredRunner][]> => {
    const oldest = entries.slice(0, ENTRIES_CHECKED_AT_CAP);
    const projectIds = oldest.map(([key]) => ctx.db.normalizeId("projects", key)).filter((id) => id !== null);
    const deviceIds = oldest.map(([, runner]) => ctx.db.normalizeId("devices", runner.deviceId)).filter((id) => id !== null);
    // `ctx.db` sees every row here: this runs only inside the internal ingest mutation (`acp/ingest.ts`), which has no RLS scope.
    const { page: projects } = projectIds.length > 0 ? await ctx.db.projects.findMany({ where: { _id: { in: projectIds } } }) : { page: [] };
    const { page: devices } = deviceIds.length > 0 ? await ctx.db.devices.findMany({ where: { _id: { in: deviceIds }, userId } }) : { page: [] };
    const projectOf = new Map(projects.map((row) => [row._id as string, row]));
    const ownDevices = new Set<string>(devices.map((row) => row._id));
    const organizations = [...new Set(projects.flatMap((row) => (row.userId !== userId && row.organizationId ? [row.organizationId] : [])))];
    const memberOf = new Set<string>();

    for (const organizationId of organizations) {
        // From the primary: a membership revoked a moment ago leaves an entry that can no longer be read.
        if ((await getMemberByOrganizationAndUser(ctx, organizationId, userId, "primary")) !== null) {
            memberOf.add(organizationId);
        }
    }

    const usable = ([key, runner]: [string, StoredRunner]): boolean => {
        const project = projectOf.get(key);

        return (
            project !== undefined &&
            entryApplies(project, runner.threadAt) &&
            (project.userId === userId || memberOf.has(project.organizationId ?? "")) &&
            ownDevices.has(runner.deviceId)
        );
    };
    const gone = new Set(oldest.filter((entry) => !usable(entry)).map(([key]) => key));

    return gone.size > 0 ? entries.filter(([key]) => !gone.has(key)) : entries.slice(1);
};

/**
 * Records the runner of a session the computer's agent has opened, for the project its thread is in (none when the project is gone).
 * Called where the session turns idle, so a start the computer refused or never opened leaves the default it had. A session that
 * opens in an older thread (a switch or `/clear` there) leaves the default a newer thread recorded.
 */
export const rememberOpenedRunner = async (
    ctx: MutationCtx,
    thread: Pick<Doc<"threads">, "_creationTime" | "createdAt"> & { projectId: Id<"projects"> },
    session: Doc<"acpSessions">,
): Promise<void> => {
    // The internal ingest mutation has no RLS scope, so `ctx.db` finds the project whichever space the thread was started from.
    // From the primary: whose row is written is decided on its owner and organization, which a lagging replica can still hold old.
    const project = await ctx.db.projects.findFirst({ consistency: "primary", where: { _id: thread.projectId } });

    // A personal project's row is its owner's: a member's thread left in it after it moved out of an organization records nothing there.
    if (!project || (!project.organizationId && project.userId !== session.userId)) {
        return;
    }

    await rememberProjectRunner(
        ctx,
        project,
        session.userId,
        { agentKey: session.agentKey, deviceId: session.deviceId as string, folderId: session.folderId },
        thread.createdAt ?? thread._creationTime,
    );
};

/**
 * Records the runner a host thread in `project` started on, for the next new thread there, unless a thread started after
 * `threadAt` (the thread's own start time) recorded one already. Runs in the internal ingest mutation, a device post with no
 * signed-in user, so the settings write has no active organization to pass; the key is not a managed setting either
 * (`settings-lock.guard.test.ts` lists this writer).
 */
export const rememberProjectRunner = async (
    ctx: MutationCtx,
    project: Doc<"projects">,
    userId: string,
    runner: ProjectRunner,
    threadAt: number,
): Promise<void> => {
    if (!project.organizationId) {
        if ((project.runnerThreadAt ?? -Infinity) > threadAt) {
            return;
        }

        await setProjectRunnerDefault(ctx.db, project, runner, threadAt);

        return;
    }

    // A thread started before the project's last move records nothing: `projectRunnerOf` would never return the entry, and at the
    // cap it would push out one that still applies.
    if (!entryApplies(project, threadAt)) {
        return;
    }

    const settings = await ctx.db.userSettings.findFirst({ where: { userId } });
    const current: StoredRunner | undefined = settings?.projectRunnerDefaults?.[project._id];

    if ((current?.threadAt ?? -Infinity) > threadAt) {
        return;
    }

    // Re-recording a project moves it to the end, so the entries at the front are the ones used longest ago.
    const others = Object.entries(settings?.projectRunnerDefaults ?? {}).filter(([key]) => key !== project._id);
    const roomy = others.length < MAX_PROJECT_RUNNER_DEFAULTS ? others : await entriesWithRoom(ctx, userId, others);
    const kept = roomy.slice(-(MAX_PROJECT_RUNNER_DEFAULTS - 1));

    await saveUserSettings(ctx.db, settings, userId, { projectRunnerDefaults: { ...Object.fromEntries(kept), [project._id]: { ...runner, threadAt } } }, null);
};
