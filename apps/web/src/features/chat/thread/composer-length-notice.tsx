import { useLingui } from "@lingui/react/macro";
import { MAX_PROMPT_CHARS } from "@neore/ai/constants";
import { Button } from "@neore/ui/components/button";
import { formatNumber } from "@neore/ui/utils/locale-format";

interface ComposerLengthNoticeProps {
    /** Characters in the draft. */
    chars: number;
    /** DOM id, so the field and the send buttons can name this notice as their description. */
    id?: string;
    /** Moves the whole draft into a text attachment; leave out where the text cannot become one (an edit). */
    onAttachAsFile?: () => void;
    /** The text would exceed the attachment or context limit even as a file, so no file is offered. */
    tooLongForFile?: boolean;
}

/** Says what the cap is, instead of letting the send fail on the server's size limit. Nothing renders under the cap. */
export const ComposerLengthNotice = ({ chars, id, onAttachAsFile, tooLongForFile = false }: ComposerLengthNoticeProps) => {
    const { i18n, t } = useLingui();

    if (chars <= MAX_PROMPT_CHARS) {
        return null;
    }

    const count = formatNumber(chars, i18n.locale);
    const limit = formatNumber(MAX_PROMPT_CHARS, i18n.locale);
    let noticeText = t`This message has ${count} characters; the limit is ${limit}. Shorten it.`;

    if (tooLongForFile) {
        noticeText = t`This message has ${count} characters; the limit is ${limit}. It is too long to send even as a file. Shorten it.`;
    } else if (onAttachAsFile) {
        noticeText = t`This message has ${count} characters; the limit is ${limit}. Shorten it, or attach it as a file.`;
    }

    return (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-sm text-red-600 dark:text-red-400" id={id} role="alert">
            <span>{noticeText}</span>
            {onAttachAsFile && !tooLongForFile && (
                <Button onClick={onAttachAsFile} size="sm" type="button" variant="outline">
                    {t`Attach as file`}
                </Button>
            )}
        </div>
    );
};
