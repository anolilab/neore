/**
 * The version list grouped by calendar day for display. The server already
 * keeps one snapshot per author per 10-minute window
 * (`backend/lunora/pages/logic.ts#snapshotAction`); this only adds the headings.
 */

export interface VersionLike {
    _id: string;
    createdAt: number;
    updatedAt: number;
}

export interface VersionGroup<T extends VersionLike> {
    /** Local midnight of the day, for a stable key and for formatting. */
    day: number;
    versions: T[];
}

const startOfDay = (timestamp: number): number => {
    const date = new Date(timestamp);

    date.setHours(0, 0, 0, 0);

    return date.getTime();
};

/** Newest first, grouped by the local day each version was last written. */
export const groupVersionsByDay = <T extends VersionLike>(versions: ReadonlyArray<T>): VersionGroup<T>[] => {
    const groups: VersionGroup<T>[] = [];

    const newestFirst = versions.toSorted((a, b) => b.updatedAt - a.updatedAt);

    for (const version of newestFirst) {
        const day = startOfDay(version.updatedAt);
        const last = groups.at(-1);

        if (last?.day === day) {
            last.versions.push(version);
        } else {
            groups.push({ day, versions: [version] });
        }
    }

    return groups;
};

/** Whether `day` is today, yesterday or earlier relative to `now` — picks the heading. */
export const dayKind = (day: number, now: number): "earlier" | "today" | "yesterday" => {
    const today = startOfDay(now);

    if (day === today) {
        return "today";
    }

    return day === startOfDay(today - 1) ? "yesterday" : "earlier";
};
