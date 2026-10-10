import { useLingui } from "@lingui/react/macro";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import cn from "../utils/cn";
import { Button } from "./button";

const ModeToggle = ({ className }: { className?: string }) => {
    const { t } = useLingui();
    const { setTheme, theme } = useTheme();

    const toggleTheme = () => {
        setTheme(theme === "dark" ? "light" : "dark");
    };

    return (
        <Button className={cn("relative size-6 overflow-hidden", className)} onClick={toggleTheme} size="icon" variant="ghost">
            <Sun
                className={cn("absolute scale-100 rotate-0 transform opacity-100 transition-all duration-200 ease-in-out", {
                    "scale-0 rotate-90 opacity-0": theme === "dark",
                })}
            />
            <Moon
                className={cn("absolute scale-0 -rotate-90 transform opacity-0 transition-all duration-200 ease-in-out", {
                    "scale-100 rotate-0 opacity-100": theme === "dark",
                })}
            />
            <span className="sr-only">{t`Toggle theme`}</span>
        </Button>
    );
};

export default ModeToggle;
