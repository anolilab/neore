/**
 * The usage activity rollup's pure half: what one reply adds to the per-day
 * rows, how a day key is formed and shifted, and how read rows fold into the
 * heatmap and the per-skill breakdown. I/O lives in `activity.ts`; this file is
 * pinned by `activity-logic.test.ts`.
 *
 * One reply writes TWO rows on the user's shard: the day's total
 * (`skillKey = TOTAL_SKILL_KEY`, what the heatmap reads — at most one row per
 * day, so a year is ≤ 371 rows) and the day's row for the skill that answered
 * (what the breakdown reads). Rows are summed on read rather than assumed
 * unique, so a guest→account merge that lands two rows for one key still adds up.
 */
import { sumMessageCosts, sumStepUsage } from "../agent/message-cost";
import type { StepUsage } from "../agent/message-cost";
import { localDayOf } from "../memory/reflection-logic";

/** `skillKey` of the per-day total row the heatmap reads. */
export const TOTAL_SKILL_KEY = "__total__";

/** `skillKey` of replies no skill produced — the plain assistant. */
export const DEFAULT_SKILL_KEY = "__assistant__";

/** `skillKey` of the Daily Brief (`notifications/daily-brief.ts`), which runs no skill and writes no thread. */
export const DAILY_BRIEF_SKILL_KEY = "__daily_brief__";

/** 53 weeks: the heatmap's window, and the most total rows one read returns. */
export const HEATMAP_DAYS = 53 * 7;

/** Rows one breakdown read takes (total rows included) — about ten skills a day over a full year. */
export const BREAKDOWN_ROW_LIMIT = 4000;

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
    providerMetadata?: unknown;
    usage?: StepUsage;
}

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
    const replyKey = savedMessages.find((row) => row.message?.role !== "user")?._id;

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
    };
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

/** Fold per-skill rows (total rows are skipped) into one entry per skill, costliest first. */
export const foldSkillTotals = (rows: ReadonlyArray<RollupRowLike>): SkillTotal[] => {
    const bySkill = new Map<string, SkillTotal & { nameAt: number }>();

    for (const row of rows) {
        if (row.skillKey === TOTAL_SKILL_KEY) {
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
