"use client";

import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import { useEffect, useState } from "react";

type Font = "inter" | "system" | "serif" | "mono" | "roboto-slab";
type CodeFont = "fira-code" | "mono" | "consolas" | "jetbrains" | "source-code-pro";

const useFont = () => {
    const [mainFont, setMainFont] = useState<Font>("inter");
    const [codeFont, setCodeFont] = useState<CodeFont>("fira-code");
    // Track hydration state to prevent accessing browser APIs during SSR
    const isHydrated = useIsHydrated();

    // Hydration-safe: Only access localStorage after client-side hydration
    useEffect(() => {
        const storedMainFont = localStorage.getItem("mainFont") as Font | null;
        const storedCodeFont = localStorage.getItem("codeFont") as CodeFont | null;

        if (storedMainFont) {
            setMainFont(storedMainFont);
        }

        if (storedCodeFont) {
            setCodeFont(storedCodeFont);
        }
    }, []);

    useEffect(() => {
        // Skip during SSR/hydration to prevent hydration mismatches
        if (!isHydrated) {
            return;
        }

        document.body.classList.remove("font-sans", "font-serif", "font-mono", "font-roboto-slab");

        switch (mainFont) {
            case "mono": {
                document.body.classList.add("font-mono");
                break;
            }
            case "roboto-slab": {
                document.body.classList.add("font-roboto-slab");
                break;
            }
            case "serif": {
                document.body.classList.add("font-serif");
                break;
            }
            case "system": {
                document.body.classList.add("font-sans");
                break;
            }
            default: {
                document.body.classList.add("font-sans");
            }
        }

        localStorage.setItem("mainFont", mainFont);
    }, [mainFont, isHydrated]);

    useEffect(() => {
        // Skip during SSR/hydration to prevent hydration mismatches
        if (!isHydrated) {
            return;
        }

        const codeElements = document.querySelectorAll("code, pre, kbd");

        codeElements.forEach((element) => {
            element.classList.remove("font-fira-code", "font-mono", "font-consolas", "font-jetbrains", "font-source-code-pro");

            switch (codeFont) {
                case "consolas": {
                    element.classList.add("font-consolas");
                    break;
                }
                case "fira-code": {
                    element.classList.add("font-fira-code");
                    break;
                }
                case "jetbrains": {
                    element.classList.add("font-jetbrains");
                    break;
                }
                case "mono": {
                    element.classList.add("font-mono");
                    break;
                }
                case "source-code-pro": {
                    element.classList.add("font-source-code-pro");
                    break;
                }
                default: {
                    element.classList.add("font-fira-code");
                }
            }
        });
        localStorage.setItem("codeFont", codeFont);
    }, [codeFont, isHydrated]);

    return { codeFont, mainFont, setCodeFont, setMainFont };
};

export default useFont;
