"use client";

import { useEffect, useState } from "react";

/**
 * Hook to track cursor position in an input element.
 */
const useCursorPosition = (inputSelector: string): number => {
    const [cursorPosition, setCursorPosition] = useState(0);

    useEffect(() => {
        let input: HTMLTextAreaElement | HTMLInputElement | null = null;
        let timeoutId: NodeJS.Timeout | null = null;
        let rafId: number | null = null;
        let cleanupFunction: (() => void) | null = null;

        const handleSelectionChange = () => {
            if (!input) {
                return;
            }

            const pos = input.selectionStart ?? 0;

            setCursorPosition(pos);
        };

        const handleKeyDown = () => {
            // Update cursor position on keydown for immediate feedback
            if (rafId) {
                cancelAnimationFrame(rafId);
            }

            rafId = requestAnimationFrame(() => {
                if (input) {
                    const pos = input.selectionStart ?? 0;

                    setCursorPosition(pos);
                }

                rafId = null;
            });
        };

        const setupListeners = () => {
            input = document.querySelector(inputSelector) as HTMLTextAreaElement | HTMLInputElement | null;

            if (!input) {
                // Retry after a short delay if input not found
                timeoutId = setTimeout(setupListeners, 50);

                return;
            }

            // Initial position
            setCursorPosition(input.selectionStart ?? 0);

            input.addEventListener("input", handleSelectionChange, { passive: true });
            input.addEventListener("click", handleSelectionChange);
            input.addEventListener("keyup", handleSelectionChange);
            input.addEventListener("keydown", handleKeyDown);
            input.addEventListener("focus", handleSelectionChange);
            // Also listen to selectionchange on document for better tracking
            document.addEventListener("selectionchange", handleSelectionChange);

            cleanupFunction = () => {
                if (input) {
                    input.removeEventListener("input", handleSelectionChange);
                    input.removeEventListener("click", handleSelectionChange);
                    input.removeEventListener("keyup", handleSelectionChange);
                    input.removeEventListener("keydown", handleKeyDown);
                    input.removeEventListener("focus", handleSelectionChange);
                }

                document.removeEventListener("selectionchange", handleSelectionChange);
            };
        };

        // Start looking for the input
        setupListeners();

        return () => {
            if (cleanupFunction) {
                cleanupFunction();
            }

            if (timeoutId) {
                clearTimeout(timeoutId);
            }

            if (rafId) {
                cancelAnimationFrame(rafId);
            }
        };
    }, [inputSelector]);

    return cursorPosition;
};

export default useCursorPosition;
