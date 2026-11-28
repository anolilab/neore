import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { FileText } from "lucide-react";

const PagesIndex = () => {
    const { t } = useLingui();

    return (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm">
            <div aria-hidden="true" className="surface-well flex size-12 items-center justify-center rounded-xl">
                <FileText className="size-6" />
            </div>
            <h1 className="text-foreground text-[15px] font-semibold">{t`Pages`}</h1>
            <p>{t`Pick a page on the left, or create one with the + button.`}</p>
        </div>
    );
};

export const Route = createFileRoute("/_shortcut/pages/")({
    component: PagesIndex,
});
