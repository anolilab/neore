/**
 * The usage activity rollup's pure half: what one reply adds to the per-day
 * rows, how a day key is formed and shifted, and how read rows fold into the
 * heatmap and the per-skill breakdown. I/O lives in `activity.ts`; this file is
 * pinned by `activity-logic.test.ts`.
 *
 * One reply writes TWO rows on the user's shard: the day's total
 * (`skillKey = TOTAL_SKILL_KEY`, what the heatmap reads — at most one row per
 * day, so a year is ≤ 371 rows) and the day's row for the skill that answered
 * (what the breakdown reads). A reply in a thread that belongs to a project
 * writes a third: the day's row for that project (`skillKey = PROJECT_SKILL_KEY`,
 * `projectKey` = the project id). Replies outside any project write none, so
 * "No project" is the total less the projects, and the two always add up.
 * Rows are summed on read rather than assumed unique, so a guest→account merge
 * that lands two rows for one key still adds up.
 */
import { sumMessageCosts, sumStepUsage } from "../agent/message-cost";
import type { StepUsage } from "../agent/message-cost";
import { localDayOf } from "../memory/reflection-logic";

/** `skillKey` of the per-day total row the heatmap reads. */
export const TOTAL_SKILL_KEY = "__total__";

/** `skillKey` of the per-day rows of one project (`projectKey`), what the project breakdown reads. */
export const PROJECT_SKILL_KEY = "__project__";

/**
 * `skillKey` of the per-day rows of one organization (`organizationId`): every
 * reply in that organization's threads or projects, what the organization view
 * reads as its total.
 */
export const ORGANIZATION_SKILL_KEY = "__organization__";

/** The `skillKey`s of the rollup's own rows, which no skill breakdown lists. */
const ROLLUP_SKILL_KEYS: ReadonlySet<string> = new Set([ORGANIZATION_SKILL_KEY, PROJECT_SKILL_KEY, TOTAL_SKILL_KEY]);

/** `skillKey` of replies no skill produced — the plain assistant. */
export const DEFAULT_SKILL_KEY = "__assistant__";

/** `skillKey` of the Daily Brief (`notifications/daily-brief.ts`), which runs no skill and writes no thread. */
export const DAILY_BRIEF_SKILL_KEY = "__daily_brief__";

/** 53 weeks: the heatmap's window, and the most total rows one read returns. */
export const HEATMAP_DAYS = 53 * 7;

/** Rows one breakdown read takes (total rows included) — about ten skills a day over a full year. */
export const BREAKDOWN_ROW_LIMIT = 4000;

/** Project rows one project breakdown read takes — about ten projects a day over a full year. */
export const PROJECT_ROW_LIMIT = 4000;

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether `value` is a `YYYY-MM-DD` key naming a real calendar day. */
export const isDayKey = (value: string): boolean => {
    if (!DAY_KEY_RE.test(value)) {
        return false;
    }

    const parsed = new Date(`${value}T00:00:00Z`);

    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** `dayKey` shifted by `days` calendar days (negative goes back). Pure date arithmetic, no time zone. */
export const addDays = (dayKey: string, days: number): string => {
    const parsed = Date.parse(`${dayKey}T00:00:00Z`);

    return new Date(parsed + days * DAY_MS).toISOString().slice(0, 10);
};

/** The skill a reply is attributed to; absent for the plain assistant. */
export interface ReplySkill {
    /** The `skills` row id; absent for an Agent Builder draft, which has none yet. */
    id?: string;
    /** Display label kept on the row, so a deleted skill still reads by name. */
    name: string;
}

export const skillKeyOf = (skill: ReplySkill | undefined): string => {
    if (!skill) {
        return DEFAULT_SKILL_KEY;
    }

    return skill.id ?? `draft:${skill.name}`;
};

/** The fields of a saved row a reply's usage is read from (a subset of `MessageDoc`). */
export interface SavedRowLike {
    _id?: string;
    message?: { role?: string } | null;
    order?: number;
    providerMetadata?: unknown;
    /** The thread the row is in: what the reply's project is read from. */
    threadId?: string;
    usage?: StepUsage;
}

/**
 * A run's saved rows split into the replies they make up, one per `order`. A run
 * usually saves one reply. A steered run (`chat/steering.ts`) carries on in the
 * steered message's order, so it saves two, and that is how `groupReplies`
 * (`backfill-logic.ts`) reads them back: a user row ends a reply.
 */
export const repliesByOrder = <R extends SavedRowLike>(rows: ReadonlyArray<R>): R[][] => {
    const replies: R[][] = [];

    for (const row of rows) {
        const current = replies.at(-1);

        if (current && current[0]?.order === row.order) {
            current.push(row);
        } else {
            replies.push([row]);
        }
    }

    return replies;
};

export interface ReplyUsage {
    costMicrodollars: number;
    tokens: number;
}

/**
 * What one finished run adds: the gateway cost and tokens summed over every
 * non-user row it saved. Undefined when it saved no reply row at all (a run that
 * failed before answering), which then counts as nothing.
 */
export const summariseReply = (savedMessages: ReadonlyArray<SavedRowLike>): ReplyUsage | undefined => {
    const replyRows = savedMessages.filter((row) => row.message?.role !== "user");

    if (replyRows.length === 0) {
        return undefined;
    }

    const cost = sumMessageCosts(replyRows.map((row) => row.providerMetadata));
    const usage = sumStepUsage(replyRows.map((row) => row.usage));

    return {
        costMicrodollars: Math.round(cost?.microdollars ?? 0),
        tokens: usage?.totalTokens ?? 0,
    };
};

/** The user's calendar day at `instant`, in their zone (UTC when unset or unusable). */
export const usageDayOf = (instant: number, timeZone: string | null | undefined): string => localDayOf(instant, timeZone);

/** The arguments of `usage_activity.recordReplyUsage`. */
export interface ReplyUsageArgs {
    at: number;
    costMicrodollars: number;
    date: string;
    /** What makes the record idempotent: the reply's first row id, or a key of the run's own. */
    replyKey: string;
    skillKey: string;
    skillName?: string;
    /** The thread the reply is in; its project, read when the record lands, gets the reply's usage too. */
    threadId?: string;
    tokens: number;
    userId: string;
}

/**
 * What a finished run records, keyed on its first reply row — the same key the
 * backfill (`backfill-logic.ts`) gives that reply, so neither counts it twice.
 * Undefined when the run saved no reply row.
 */
export const replyUsageArgs = (
    savedMessages: ReadonlyArray<SavedRowLike>,
    options: { at: number; skill?: ReplySkill; timeZone?: string; userId: string },
): ReplyUsageArgs | undefined => {
    const usage = summariseReply(savedMessages);
    const first = savedMessages.find((row) => row.message?.role !== "user");
    const replyKey = first?._id;

    if (!usage || replyKey === undefined) {
        return undefined;
    }

    return {
        at: options.at,
        costMicrodollars: usage.costMicrodollars,
        date: usageDayOf(options.at, options.timeZone),
        replyKey,
        skillKey: skillKeyOf(options.skill),
        tokens: usage.tokens,
        userId: options.userId,
        ...(options.skill && { skillName: options.skill.name }),
        ...(first?.threadId !== undefined && { threadId: first.threadId }),
    };
};

/** The key `usageReplies` holds once a reply (keyed `replyKey`) has been filed under its project and organization. */
export const projectFiledKey = (replyKey: string): string => `project:${replyKey}`;

/** Where a reply is filed besides the total: its thread's project, and the organization the reply belongs to. */
export interface Attribution {
    /** The organization of the thread's project, else of the thread itself. */
    organizationId?: string;
    /** Set when the organization owns the project: only then is the project one of the organization's. */
    projectInOrganization?: boolean;
    projectKey?: string;
}

/** What some replies of one day add to their project's and organization's rows. */
export interface AttributionIncrement extends Attribution {
    costMicrodollars: number;
    date: string;
    replies: number;
    tokens: number;
}

/** One project or organization row a write touches. */
export interface AttributionRow {
    costMicrodollars: number;
    date: string;
    /** On an organization row, the organization; on a project row, the organization it was filed under, if any. */
    organizationId?: string;
    /** Project rows only. */
    projectKey?: string;
    replies: number;
    skillKey: typeof ORGANIZATION_SKILL_KEY | typeof PROJECT_SKILL_KEY;
    tokens: number;
}

/**
 * The rows some increments touch, each once: a project row per (day, project,
 * organization) and an organization row per (day, organization). A reply in an
 * organization's project lands in both, so the organization's projects never
 * add up to more than its total.
 */
export const attributionRows = (increments: ReadonlyArray<AttributionIncrement>): AttributionRow[] => {
    const rows = new Map<string, AttributionRow>();
    const add = (row: AttributionRow) => {
        const key = [row.date, row.skillKey, row.projectKey ?? "", row.organizationId ?? ""].join("\u{0}");
        const current = rows.get(key);

        if (current) {
            current.costMicrodollars += row.costMicrodollars;
            current.replies += row.replies;
            current.tokens += row.tokens;
        } else {
            rows.set(key, { ...row });
        }
    };

    for (const { costMicrodollars, date, organizationId, projectInOrganization, projectKey, replies, tokens } of increments) {
        const amounts = { costMicrodollars, date, replies, tokens };

        // A member's own project in an organization's thread stays theirs: its row carries no organization, so the
        // organization's view never lists it (the spend still counts in the organization's total, as "No project").
        if (projectKey !== undefined) {
            add({
                ...amounts,
                projectKey,
                skillKey: PROJECT_SKILL_KEY,
                ...(organizationId !== undefined && projectInOrganization === true && { organizationId }),
            });
        }

        if (organizationId !== undefined) {
            add({ ...amounts, organizationId, skillKey: ORGANIZATION_SKILL_KEY });
        }
    }

    return [...rows.values()];
};

/** What some replies of one day and skill add to the rollup. */
export interface RollupIncrement {
    costMicrodollars: number;
    date: string;
    replies: number;
    skillKey: string;
    skillName?: string;
    tokens: number;
}

/**
 * Increments folded into one per (day, skill), plus the day's total row for
 * each day — the rows a write touches, each once.
 */
export const withDayTotals = (increments: ReadonlyArray<RollupIncrement>): RollupIncrement[] => {
    const rows = new Map<string, RollupIncrement>();
    const add = (increment: RollupIncrement) => {
        const key = `${increment.date}\u{0}${increment.skillKey}`;
        const current = rows.get(key);

        if (current) {
            current.costMicrodollars += increment.costMicrodollars;
            current.replies += increment.replies;
            current.tokens += increment.tokens;

            if (current.skillName === undefined && increment.skillName !== undefined) {
                current.skillName = increment.skillName;
            }
        } else {
            rows.set(key, { ...increment });
        }
    };

    for (const increment of increments) {
        if (increment.skillKey === TOTAL_SKILL_KEY) {
            continue;
        }

        add(increment);
        add({
            costMicrodollars: increment.costMicrodollars,
            date: increment.date,
            replies: increment.replies,
            skillKey: TOTAL_SKILL_KEY,
            tokens: increment.tokens,
        });
    }

    return [...rows.values()];
};

export interface DayTotal {
    costMicrodollars: number;
    date: string;
    replies: number;
    tokens: number;
}

interface RollupRowLike {
    costMicrodollars: number;
    date: string;
    organizationId?: string;
    projectKey?: string;
    replies: number;
    skillKey: string;
    skillName?: string;
    tokens: number;
    updatedAt: number;
}

/** Fold total rows into one entry per day, oldest first. */
export const foldDayTotals = (rows: ReadonlyArray<RollupRowLike>): DayTotal[] => {
    const byDay = new Map<string, DayTotal>();

    for (const row of rows) {
        const current = byDay.get(row.date) ?? { costMicrodollars: 0, date: row.date, replies: 0, tokens: 0 };

        current.costMicrodollars += row.costMicrodollars;
        current.replies += row.replies;
        current.tokens += row.tokens;
        byDay.set(row.date, current);
    }

    return [...byDay.values()].toSorted((a, b) => a.date.localeCompare(b.date));
};

export interface SkillTotal {
    costMicrodollars: number;
    replies: number;
    skillKey: string;
    /** Absent for the plain assistant; the UI names it. */
    skillName?: string;
    tokens: number;
}

/** Fold per-skill rows (total and project rows are skipped) into one entry per skill, costliest first. */
export const foldSkillTotals = (rows: ReadonlyArray<RollupRowLike>): SkillTotal[] => {
    const bySkill = new Map<string, SkillTotal & { nameAt: number }>();

    for (const row of rows) {
        if (ROLLUP_SKILL_KEYS.has(row.skillKey)) {
            continue;
        }

        const current = bySkill.get(row.skillKey) ?? { costMicrodollars: 0, nameAt: -1, replies: 0, skillKey: row.skillKey, tokens: 0 };

        current.costMicrodollars += row.costMicrodollars;
        current.replies += row.replies;
        current.tokens += row.tokens;

        // The newest label wins: a renamed skill reads by its current name.
        if (row.skillName !== undefined && row.updatedAt > current.nameAt) {
            current.skillName = row.skillName;
            current.nameAt = row.updatedAt;
        }

        bySkill.set(row.skillKey, current);
    }

    return [...bySkill.values()]
        .map(({ nameAt: _nameAt, ...total }) => total)
        .toSorted((a, b) => b.costMicrodollars - a.costMicrodollars || b.replies - a.replies || a.skillKey.localeCompare(b.skillKey));
};

export interface UsageTotals {
    costMicrodollars: number;
    replies: number;
    tokens: number;
}

export interface ProjectTotal extends UsageTotals {
    projectKey: string;
}

const emptyTotals = (): UsageTotals => {
    return { costMicrodollars: 0, replies: 0, tokens: 0 };
};

/** The sum of some rows, whatever their kind. */
export const sumRows = (rows: ReadonlyArray<UsageTotals>): UsageTotals => {
    const sum = emptyTotals();

    for (const row of rows) {
        sum.costMicrodollars += row.costMicrodollars;
        sum.replies += row.replies;
        sum.tokens += row.tokens;
    }

    return sum;
};

/** Fold project rows (others are skipped) into one entry per project, costliest first. */
export const foldProjectTotals = (rows: ReadonlyArray<RollupRowLike>): ProjectTotal[] => {
    const byProject = new Map<string, ProjectTotal>();

    for (const row of rows) {
        if (row.skillKey !== PROJECT_SKILL_KEY || row.projectKey === undefined) {
            continue;
        }

        const current = byProject.get(row.projectKey) ?? { ...emptyTotals(), projectKey: row.projectKey };

        current.costMicrodollars += row.costMicrodollars;
        current.replies += row.replies;
        current.tokens += row.tokens;
        byProject.set(row.projectKey, current);
    }

    return [...byProject.values()].toSorted(
        (a, b) => b.costMicrodollars - a.costMicrodollars || b.replies - a.replies || a.projectKey.localeCompare(b.projectKey),
    );
};

/**
 * What no project accounts for: the total less every project, never below zero.
 * Replies outside a project write no project row, so this is their sum.
 */
export const remainderOf = (total: UsageTotals, projects: ReadonlyArray<UsageTotals>): UsageTotals => {
    const filed = sumRows(projects);

    return {
        costMicrodollars: Math.max(0, total.costMicrodollars - filed.costMicrodollars),
        replies: Math.max(0, total.replies - filed.replies),
        tokens: Math.max(0, total.tokens - filed.tokens),
    };
};

/**
 * One member's rows filed under an organization, folded: the organization row
 * total, and the project rows per project. Projects come only from rows filed
 * under this organization, so they add up to at most its total.
 */
export const foldOrganizationRows = (rows: ReadonlyArray<RollupRowLike>, organizationId: string): { projects: ProjectTotal[]; total: UsageTotals } => {
    const filed = rows.filter((row) => row.organizationId === organizationId);

    return {
        projects: foldProjectTotals(filed),
        total: sumRows(filed.filter((row) => row.skillKey === ORGANIZATION_SKILL_KEY)),
    };
};

/** Totals added into `into`, per project key. */
export const addProjectTotals = (into: Map<string, UsageTotals>, projects: ReadonlyArray<ProjectTotal>): void => {
    for (const project of projects) {
        const current = into.get(project.projectKey) ?? { costMicrodollars: 0, replies: 0, tokens: 0 };

        current.costMicrodollars += project.costMicrodollars;
        current.replies += project.replies;
        current.tokens += project.tokens;
        into.set(project.projectKey, current);
    }
};
