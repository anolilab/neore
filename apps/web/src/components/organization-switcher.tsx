import { Trans } from "@lingui/react/macro";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from "@neore/ui/components/responsive-dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@neore/ui/components/sidebar";
import { ChevronsUpDown, Plus } from "lucide-react";
import type { ElementType } from "react";
import { useState } from "react";

const OrganizationSwitcher = ({
    organizations,
}: {
    organizations: {
        logo: ElementType;
        name: string;
        plan: string;
    }[];
}) => {
    const { isMobile } = useSidebar("organization-switcher");
    const [activeOrganizationName, setActiveOrganizationName] = useState<string | undefined>(undefined);
    const activeOrganization = organizations.find((organization) => organization.name === activeOrganizationName) ?? organizations[0];

    if (!activeOrganization) {
        return null;
    }

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <SidebarMenuButton
                                className="data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-sidebar-accent-foreground"
                                name="organization-switcher"
                                size="lg"
                            >
                                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                                    <activeOrganization.logo className="size-4" />
                                </div>
                                <div className="grid flex-1 text-left text-sm leading-tight">
                                    <span className="truncate font-medium">{activeOrganization.name}</span>
                                    <span className="truncate text-xs">{activeOrganization.plan}</span>
                                </div>
                                <ChevronsUpDown aria-hidden="true" className="ml-auto" />
                            </SidebarMenuButton>
                        }
                    />
                    <DropdownMenuContent
                        align="start"
                        className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                        side={isMobile ? "bottom" : "right"}
                        sideOffset={4}
                    >
                        <DropdownMenuGroup>
                            <DropdownMenuLabel className="text-muted-foreground text-xs">
                                <Trans>Teams</Trans>
                            </DropdownMenuLabel>
                            {organizations.map((organization, index) => (
                                <DropdownMenuItem
                                    className="gap-2 p-2"
                                    key={organization.name}
                                    onClick={() => {
                                        setActiveOrganizationName(organization.name);
                                    }}
                                >
                                    <div className="flex size-6 items-center justify-center rounded-md border">
                                        <organization.logo className="size-3.5 shrink-0" />
                                    </div>
                                    {organization.name}
                                    <DropdownMenuShortcut>⌘{index + 1}</DropdownMenuShortcut>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="gap-2 p-2">
                            <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                                <Plus aria-hidden="true" className="size-4" />
                            </div>
                            <div className="text-muted-foreground font-medium">
                                <Trans>Add team</Trans>
                            </div>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
};

export default OrganizationSwitcher;
