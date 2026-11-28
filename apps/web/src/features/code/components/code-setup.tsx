import type { FC } from "react";

import GitHostStep from "@/features/code/components/git-host-step";
import type { CodeHost } from "@/features/code/components/host-details";
import { useServerFormShown } from "@/features/code/hooks/use-server-form-shown";
import SetupChecklist from "@/features/onboarding/components/setup-checklist";

/** The main area of /code until the coding setup is settled: the setup steps, then the Git host step in the same list. */
const CodeSetup: FC<{ devices: ReadonlyArray<CodeHost> }> = ({ devices }) => {
    const serverFormShown = useServerFormShown(devices);

    return (
        <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-2xl p-4 md:p-8">
                <SetupChecklist extra={<GitHostStep />} serverFormShown={serverFormShown} surface="code" />
            </div>
        </div>
    );
};

export default CodeSetup;
