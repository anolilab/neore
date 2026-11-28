"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { SunMoonIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { FC } from "react";

import { OVERFLOW_ROW_CLASS } from "./header-row";

/** The header's theme switch as a labelled row of the overflow menu: the same toggle and state as `ModeToggle`. */
const ThemeRow: FC = () => {
    const { t } = useLingui();
    const { setTheme, theme } = useTheme();

    return (
        <Button className={OVERFLOW_ROW_CLASS} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} variant="ghost">
            <SunMoonIcon aria-hidden="true" className="size-4" />
            {t`Toggle theme`}
        </Button>
    );
};

export default ThemeRow;
