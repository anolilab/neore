"use client";

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

interface ModelPickerPopupOptions {
    initialModelId?: string;
    onSelect?: (modelId: string) => void;
}

interface ModelPickerPopupStore {
    close: () => void;
    isOpen: boolean;

    open: (options?: ModelPickerPopupOptions) => void;
    options: ModelPickerPopupOptions | undefined;
}

export const useModelPickerPopupStore = create<ModelPickerPopupStore>((set) => {
    return {
        close: () => {
            set({ isOpen: false, options: undefined });
        },
        isOpen: false,

        open: (options) => {
            set({ isOpen: true, options });
        },

        options: undefined,
    };
});

export const useModelPickerPopupState = () =>
    useModelPickerPopupStore(
        useShallow((state) => {
            return {
                isOpen: state.isOpen,
                options: state.options,
            };
        }),
    );

export const useModelPickerPopupActions = () =>
    useModelPickerPopupStore(
        useShallow((state) => {
            return {
                close: state.close,
                open: state.open,
            };
        }),
    );
