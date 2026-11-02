import { useLingui } from "@lingui/react/macro";
import { MAX_PROMPT_CHARS } from "@neore/ai/constants";
import { Button } from "@neore/ui/components/button";
import { formatNumber } from "@neore/ui/utils/locale-format";

interface ComposerLengthNoticeProps {
    /** Characters in the draft. */
    chars: number;
    /** Moves the whole draft into a text attachment; leave out where the text cannot become one (an edit). */
    onAttachAsFile?: () => void;
}

/** Says what the cap is, instead of letting the send fail on the server's size limit. Nothing renders under the cap. */
export const ComposerLengthNotice = ({ chars, onAttachAsFile }: ComposerLengthNoticeProps) => {
    const { i18n, t } = useLingui();

    if (chars <= MAX_PROMPT_CHARS) {
        return null;
    }

    return (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-sm text-red-600 dark:text-red-400" role="alert">
            <span>
                {onAttachAsFile
                    ? t`This message has ${formatNumber(chars, i18n.locale)} characters; the limit is ${formatNumber(MAX_PROMPT_CHARS, i18n.locale)}. Shorten it, or attach it as a file.`
                    : t`This message has ${formatNumber(chars, i18n.locale)} characters; the limit is ${formatNumber(MAX_PROMPT_CHARS, i18n.locale)}. Shorten it.`}
            </span>
            {onAttachAsFile && (
                <Button onClick={onAttachAsFile} size="sm" type="button" variant="outline">
                    {t`Attach as file`}
                </Button>
            )}
        </div>
    );
};
