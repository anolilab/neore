import { Trans } from "@lingui/react/macro";
import { Loader2Icon } from "lucide-react";

const DefaultLoading = () => (
    <div className="mx-auto mt-8 flex flex-col items-center justify-center">
        <Loader2Icon className="animate-spin" />
        <p className="text-muted-foreground mt-2 text-sm">
            <Trans>Loading...</Trans>
        </p>
    </div>
);

export default DefaultLoading;
