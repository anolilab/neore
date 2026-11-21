import { createContext, use } from "react";

/**
 * Opens the thread's image gallery at the image with this key (`utils/thread-images.ts`); `opener` is the control that
 * opened it, which gets the focus back when the gallery closes. Provided by the app; without a provider, tool images
 * render as plain images.
 */
export type OpenImage = (key: string, opener?: HTMLElement) => void;

export const ImageOpenContext = createContext<OpenImage | null>(null);

/** The gallery opener, or `null` when the app shows no gallery. */
export const useImageOpener = (): OpenImage | null => use(ImageOpenContext);
