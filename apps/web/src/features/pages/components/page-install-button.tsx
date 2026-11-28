import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";

import { useInstallApp } from "@/features/download/lib/use-install-app";
import { useNativeCapability } from "@/lib/native/use-native-capability";

import { pageManifestHref } from "../lib/page-manifest";

/**
 * Offers "Install this page" when the browser has a prompt for this page's manifest. It is hidden in the desktop
 * shell with page windows, which opens the page in its own window instead.
 */
const PageInstallButton = ({ pageId }: { pageId: string }) => {
    const { t } = useLingui();
    const { canInstall, install } = useInstallApp(pageManifestHref(pageId));
    const hasPageWindows = useNativeCapability("page-windows");

    if (!canInstall || hasPageWindows) {
        return null;
    }

    return (
        <Button
            onClick={() => {
                void install();
            }}
            size="sm"
            variant="ghost"
        >
            {t`Install this page`}
        </Button>
    );
};

export default PageInstallButton;
