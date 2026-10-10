"use client";

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

interface CommandDialogStore {
    close: () => void;

    isOpen: boolean;
    openCommandPalette: () => void;
    setOpen: (open: boolean) => void;
}

export const useCommandDialogStore = create<CommandDialogStore>((set) => {
    return {
        close: () => {
            set({ isOpen: false });
        },

        isOpen: false,

        openCommandPalette: () => {
            set({ isOpen: true });
        },

        setOpen: (open) => {
            set((state) => {
                if (open === state.isOpen) {
                    return state;
                }

                return { isOpen: open };
            });
        },
    };
});

export const useCommandDialogState = () =>
    useCommandDialogStore(
        useShallow((state) => {
            return {
                isOpen: state.isOpen,
            };
        }),
    );

export const useCommandDialogActions = () =>
    useCommandDialogStore(
        useShallow((state) => {
            return {
                close: state.close,
                openCommandPalette: state.openCommandPalette,
                setOpen: state.setOpen,
            };
        }),
    );
