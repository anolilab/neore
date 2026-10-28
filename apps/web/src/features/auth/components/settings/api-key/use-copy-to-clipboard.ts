import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";

const COPIED_MS = 2000;

/** `copied` turns true only once the write succeeded; a refused write (no permission, insecure context) raises an error toast instead. */
const useCopyToClipboard = () => {
    const { toast } = useAuth();
    const { t } = useLingui();
    const [copied, setCopied] = useState(false);

    const copy = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            toast({ message: t`Could not copy to the clipboard`, variant: "error" });

            return;
        }

        setCopied(true);
        setTimeout(() => {
            setCopied(false);
        }, COPIED_MS);
    };

    return { copied, copy };
};

export default useCopyToClipboard;
