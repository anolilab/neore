import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { Button } from "./button";
import { useAppForm } from "./form";
import { Input } from "./input";

interface DemoFormProps {
    initialName?: string;
    required?: boolean;
}

const DemoForm = ({ initialName = "", required = false }: DemoFormProps) => {
    const form = useAppForm({
        defaultValues: { name: initialName },
        validators: {
            onSubmit: ({ value }) => (value.name.trim() ? undefined : { fields: { name: { message: "Name is required" } } }),
        },
    });

    return (
        <form
            className="w-80"
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                form.handleSubmit().catch(() => undefined);
            }}
        >
            <form.AppField name="name">
                {(field) => (
                    <field.FormItem required={required}>
                        <field.FormLabel>Display name</field.FormLabel>
                        <field.FormControl
                            render={
                                <Input
                                    onBlur={field.handleBlur}
                                    onChange={(event) => {
                                        field.handleChange(event.target.value);
                                    }}
                                    placeholder="Ada Lovelace"
                                    value={field.state.value}
                                />
                            }
                        />
                        <field.FormDescription>Shown to other people in your workspace.</field.FormDescription>
                        <field.FormMessage />
                    </field.FormItem>
                )}
            </form.AppField>
            <Button className="mt-3" type="submit">
                Save
            </Button>
        </form>
    );
};

const meta = {
    component: DemoForm,
    title: "UI/Form",
} satisfies Meta<typeof DemoForm>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Required: Story = { args: { required: true } };

export const ValidationError: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Save" }));
        await expect(await canvas.findByText("Name is required")).toBeVisible();
        await expect(canvas.getByRole("textbox", { name: /Display name/ })).toBeInvalid();
    },
};

export const Filled: Story = { args: { initialName: "Ada Lovelace" } };
