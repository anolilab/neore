import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { NavigationMenu, NavigationMenuContent, NavigationMenuItem, NavigationMenuLink, NavigationMenuList, NavigationMenuTrigger } from "./navigation-menu";

const meta = {
    component: NavigationMenu,
    render: (args) => (
        <NavigationMenu {...args}>
            <NavigationMenuList>
                <NavigationMenuItem>
                    <NavigationMenuTrigger>Product</NavigationMenuTrigger>
                    <NavigationMenuContent>
                        <ul className="grid w-64 gap-1">
                            <li>
                                <NavigationMenuLink href="#chat">Chat</NavigationMenuLink>
                            </li>
                            <li>
                                <NavigationMenuLink href="#tasks">Tasks</NavigationMenuLink>
                            </li>
                        </ul>
                    </NavigationMenuContent>
                </NavigationMenuItem>
                <NavigationMenuItem>
                    <NavigationMenuLink href="#pricing">Pricing</NavigationMenuLink>
                </NavigationMenuItem>
            </NavigationMenuList>
        </NavigationMenu>
    ),
    title: "UI/Navigation menu",
} satisfies Meta<typeof NavigationMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: /Product/ })).toBeVisible();
        await expect(canvas.getByRole("link", { name: "Pricing" })).toBeVisible();
    },
};
