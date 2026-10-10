import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { FileText } from "lucide-react";

const PagesIndex = () => {
    const { t } = useLingui();

    return (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm">
            <FileText aria-hidden="true" className="size-8" />
            <h1 className="text-foreground text-lg font-semibold">{t`Pages`}</h1>
            <p>{t`Pick a page on the left, or create one with the + button.`}</p>
        </div>
    );
};

export const Route = createFileRoute("/_shortcut/pages/")({
    component: PagesIndex,
});
