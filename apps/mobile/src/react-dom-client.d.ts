/**
 * The part of `react-dom/client` the render-count tests use (`*.test.tsx`, under jsdom). The app never renders to a DOM,
 * and adding `@types/react-dom` to this package re-resolves the whole mobile dependency tree in the lockfile, so the two
 * calls are typed here. Drop this file once `@types/react-dom` is a devDependency of this package.
 */
declare module "react-dom/client" {
    import type { ReactNode } from "react";

    export interface Root {
        render: (children: ReactNode) => void;
        unmount: () => void;
    }

    export const createRoot: (container: Element) => Root;
}
