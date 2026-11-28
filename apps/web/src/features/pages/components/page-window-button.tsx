import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { ExternalLink } from "lucide-react";

import { openPageWindow } from "@/lib/native/bridge";
import { useNativeCapability } from "@/lib/native/use-native-capability";

/**
 * Opens the page in its own window of the desktop shell. It renders nothing in a browser or in a shell
 * that does not advertise `page-windows`. Server render and first client render both leave it out, so
 * the markup matches before the shell is known.
 */
const PageWindowButton = ({ pageId }: { pageId: string }) => {
    const { t } = useLingui();
    const available = useNativeCapability("page-windows");

    if (!available) {
        return null;
    }

    return (
        <Button
            aria-label={t`Open in new window`}
            onClick={() => {
                void openPageWindow(pageId);
            }}
            size="icon-sm"
            variant="ghost"
        >
            <ExternalLink aria-hidden="true" className="size-4" />
        </Button>
    );
};

export default PageWindowButton;
