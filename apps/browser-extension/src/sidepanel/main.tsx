// eslint-disable-next-line simple-import-sort/imports -- the stylesheet stays LAST so it cascades after any CSS the component imports pull in
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ExtensionI18nProvider } from "@/lib/i18n";
import { LunoraWithAuthProvider } from "@/lib/lunora";

import App from "./App";
import "../index.css";

// `@neore/ui` themes by a `.dark` class; follow the OS setting. Done here
// rather than in an inline <script>, which the extension CSP forbids.
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", darkQuery.matches);

applyTheme();
darkQuery.addEventListener("change", applyTheme);

createRoot(document.querySelector("#root")!).render(
    <StrictMode>
        <ExtensionI18nProvider>
            <LunoraWithAuthProvider>
                <App />
            </LunoraWithAuthProvider>
        </ExtensionI18nProvider>
    </StrictMode>,
);
