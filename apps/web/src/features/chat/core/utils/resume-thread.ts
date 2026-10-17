interface ResumeCandidate {
    _creationTime: number;
    _id: string;
    deleted?: boolean;
    status: string;
}

/**
 * The thread `/chat` should open on for a user who resumes their latest chat:
 * the newest live, non-archived thread that is not a branch of another.
 */
export const pickResumeThreadId = (threads: readonly ResumeCandidate[] | undefined, branchIds: ReadonlySet<string>): string | undefined => {
    let latest: ResumeCandidate | undefined;

    for (const thread of threads ?? []) {
        if (thread.deleted || thread.status === "archived" || branchIds.has(thread._id)) {
            continue;
        }

        if (!latest || thread._creationTime > latest._creationTime) {
            latest = thread;
        }
    }

    return latest?._id;
};
