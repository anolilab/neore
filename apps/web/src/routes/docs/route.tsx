import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";

import LandingFooter from "@/features/marketing/components/landing-footer";
import Navbar from "@/features/marketing/components/navbar-menu";

const DocsLayoutComponent = () => (
    // search disabled: fumadocs' default search uses remark-parse which calls
    // require('tty') — a Node.js built-in not available in Cloudflare Workers.
    <RootProvider search={{ enabled: false }}>
        <Navbar theme="light" />
        <Outlet />
        <LandingFooter />
    </RootProvider>
);

export const Route = createFileRoute("/docs")({
    component: DocsLayoutComponent,
});
