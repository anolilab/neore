import type { I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { AnyRouter } from "@tanstack/react-router";
import type { PropsWithChildren, ReactNode } from "react";

import { dynamicActivate } from "./client";

type AdditionalOptions = {
    WrapProvider?: (properties: { children: ReactNode }) => React.JSX.Element;
};

// Simple wrapper function that can accept props (unlike Fragment)
// This allows TanStack Router dev tools to add data-tsd-source attributes
const createPassThroughWrapper =
    (): (({ children }: PropsWithChildren) => React.JSX.Element) =>
    ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>;

export type ValidateRouter<TRouter extends AnyRouter> =
    NonNullable<TRouter["options"]["context"]> extends {
        i18n: I18n;
    }
        ? TRouter
        : never;

const routerWithLingui = <TRouter extends AnyRouter>(router: ValidateRouter<TRouter>, i18n: I18n, additionalOptions?: AdditionalOptions): TRouter => {
    const ogOptions = router.options;

    // eslint-disable-next-line no-param-reassign
    router.options = {
        ...router.options,
        context: {
            ...ogOptions.context,
            // Pass the query client to the context, so we can access it in loaders
            i18n,
        },
        // Wrap the app in a I18nProvider
        Wrap: ({ children }: PropsWithChildren) => {
            const PassThroughWrapper = createPassThroughWrapper();
            const OuterWrapper = additionalOptions?.WrapProvider || PassThroughWrapper;
            const OGWrap = ogOptions.Wrap || PassThroughWrapper;

            return (
                <OuterWrapper>
                    <I18nProvider i18n={i18n}>
                        <OGWrap>{children}</OGWrap>
                    </I18nProvider>
                </OuterWrapper>
            );
        },
    };

    if (router.isServer) {
        // eslint-disable-next-line no-param-reassign
        router.options.dehydrate = async () => {
            const ogDehydrated = await ogOptions.dehydrate?.();

            // Exclude non-serializable objects from context (LunoraReactClient, LunoraQueryClient, QueryClient)
            // These are runtime-only and should not be serialized
            const serializableDehydrated =
                ogDehydrated && typeof ogDehydrated === "object"
                    ? Object.fromEntries(Object.entries(ogDehydrated).filter(([key]) => !["lunoraClient", "queryClient"].includes(key)))
                    : ogDehydrated;

            // The locale ONLY, never `i18n.messages`. Inlining the catalog put
            // every translation of the app into every HTML response — ~178 KB of
            // a 204 KB sign-in page, uncacheable, on each full page load. The
            // client loads the same catalog as a hashed, immutable-cached chunk.
            return {
                ...serializableDehydrated,
                dehydratedI18n: {
                    locale: i18n.locale,
                },
            };
        };
    } else {
        // eslint-disable-next-line no-param-reassign
        router.options.hydrate = async (dehydrated) => {
            ogOptions.hydrate?.(dehydrated);

            // Only hydrate i18n if dehydrated data exists. Router-core awaits
            // `hydrate` before React hydrates, so the catalog is active in time
            // for the first render to match the server's markup.
            const locale = (dehydrated as { dehydratedI18n?: { locale?: string } } | undefined)?.dehydratedI18n?.locale;

            if (locale) {
                try {
                    await dynamicActivate(i18n, locale);
                } catch (error) {
                    // A failed chunk load must not take hydration down with it:
                    // the app still works, untranslated strings show their ids.
                    console.error(`[i18n] Could not load the "${locale}" catalog:`, error);
                    i18n.loadAndActivate({ locale, messages: {} });
                }
            }
        };
    }

    return router;
};

export default routerWithLingui;
