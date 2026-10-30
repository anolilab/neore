import { useLingui } from "@lingui/react/macro";

/** A write the host answered, or did not, as the actions return it. */
export interface WriteResult {
    reason?: string | null;
    status: string;
}

/** Every failure of an edit to the draft, or of a write to the host, in words for the person. */
export const useReviewMessages = (label: string) => {
    const { t } = useLingui();
    const edits: Record<string, string> = {
        head_moved: t`The change has new commits since you started this review. Submit or discard the review first, then comment on the new version.`,
        not_found: t`That comment is already gone.`,
        submitting: t`Your review is being submitted. Wait for it to finish.`,
        too_many: t`This review is too long to keep: it holds at most 100 comments and about 1 MB of text. Submit it first, or shorten it.`,
    };
    const writes: Record<string, string> = {
        forbidden: t`${label} refused this. Your account may lack access.`,
        host_error: t`${label} could not be reached or answered unexpectedly. Try again in a moment.`,
        needs_reconnect: t`Your ${label} sign-in has expired. Connect it again.`,
        not_connected: t`${label} is not connected.`,
        not_found: t`It does not exist, or your ${label} account cannot see it.`,
        rate_limited: t`${label} is limiting requests for this account. Try again in a few minutes.`,
        unconfirmed: t`${label} did not answer, so it may have taken this. Check on ${label} before trying again.`,
    };

    return {
        /** Why an edit to the draft was not made. */
        edit: (status: string): string => edits[status] ?? t`Could not save this. Try again.`,
        /** Why a write to the host did not go through. */
        write: (result: WriteResult): string => {
            if (result.status !== "rejected") {
                return writes[result.status] ?? t`Could not do this. Try again.`;
            }

            return result.reason ? t`${label} did not accept this: ${result.reason}` : t`${label} did not accept this.`;
        },
    };
};
