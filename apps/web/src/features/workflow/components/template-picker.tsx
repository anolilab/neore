import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@ui/components/responsive-dialog";
import { ScrollArea } from "@ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { useReactFlow } from "@xyflow/react";
import { Brain, Columns, Eraser, FileText, Image, LayoutTemplate, Maximize2, Palette, User, Video, Wand2 } from "lucide-react";
import { useState } from "react";

import { useWorkflowStore } from "../stores/workflow-store";
import type { WorkflowTemplate } from "../templates";
import { getTemplatesByCategory, resolveTemplateContent } from "../templates";

const CATEGORY_LABELS: Record<WorkflowTemplate["category"], { icon: React.ReactNode; label: MessageDescriptor }> = {
    audio: { icon: <Brain className="size-4" />, label: msg`Audio` },
    automation: { icon: <Brain className="size-4" />, label: msg`Automation` },
    image: { icon: <Image className="size-4" />, label: msg`Image` },
    text: { icon: <FileText className="size-4" />, label: msg`Text` },
    video: { icon: <Video className="size-4" />, label: msg`Video` },
};

const ICON_MAP: Record<string, React.ReactNode> = {
    Brain: <Brain className="size-5" />,
    Columns: <Columns className="size-5" />,
    Eraser: <Eraser className="size-5" />,
    Image: <Image className="size-5" />,
    Maximize2: <Maximize2 className="size-5" />,
    Palette: <Palette className="size-5" />,
    User: <User className="size-5" />,
    Video: <Video className="size-5" />,
    Wand2: <Wand2 className="size-5" />,
};

interface TemplateCardProps {
    onSelect: (template: WorkflowTemplate) => void;
    template: WorkflowTemplate;
}

const TemplateCard = ({ onSelect, template }: TemplateCardProps) => {
    const { i18n } = useLingui();
    const icon = ICON_MAP[template.icon] ?? <Image className="size-5" />;

    return (
        <button
            className="bg-card hover:bg-accent hover:border-primary flex w-full flex-col gap-3 rounded-lg border p-4 text-left transition-colors"
            onClick={() => onSelect(template)}
            type="button"
        >
            <div className="flex items-center gap-3">
                <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg">{icon}</div>
                <div className="min-w-0 flex-1">
                    <h3 className="truncate font-medium">{i18n._(template.name)}</h3>
                    <p className="text-muted-foreground truncate text-sm">{i18n._(template.description)}</p>
                </div>
            </div>
            {template.tags && template.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {template.tags.map((tag) => (
                        <Badge className="text-xs" key={tag.id} variant="secondary">
                            {i18n._(tag)}
                        </Badge>
                    ))}
                </div>
            )}
        </button>
    );
};

interface TemplatePickerProps {
    onTemplateSelect?: (template: WorkflowTemplate) => void;
}

const TemplatePicker = ({ onTemplateSelect }: TemplatePickerProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const [activeCategory, setActiveCategory] = useState<WorkflowTemplate["category"]>("image");
    const loadContent = useWorkflowStore((state) => state.loadContent);
    const { fitView } = useReactFlow();
    const { i18n } = useLingui();

    const handleSelect = (template: WorkflowTemplate) => {
        loadContent(resolveTemplateContent(template, i18n));
        setIsOpen(false);
        // Give React Flow one frame to process the new nodes before fitting
        requestAnimationFrame(() => {
            fitView({ duration: 400, padding: 0.15 });
        });
        onTemplateSelect?.(template);
    };

    const categories = Object.keys(CATEGORY_LABELS) as WorkflowTemplate["category"][];

    return (
        <Dialog onOpenChange={setIsOpen} open={isOpen}>
            <DialogTrigger
                render={
                    <Button className="gap-2" size="sm" variant="outline">
                        <LayoutTemplate className="size-4" />
                        <Trans>Templates</Trans>
                    </Button>
                }
            />
            <DialogContent className="max-h-[80vh] max-w-3xl">
                <DialogHeader>
                    <DialogTitle>
                        <Trans>Workflow Templates</Trans>
                    </DialogTitle>
                    <DialogDescription>
                        <Trans>Choose a template to get started quickly. Templates provide pre-configured workflows for common tasks.</Trans>
                    </DialogDescription>
                </DialogHeader>

                <Tabs onValueChange={(v) => setActiveCategory(v as WorkflowTemplate["category"])} value={activeCategory}>
                    <TabsList className="grid w-full grid-cols-5">
                        {categories.map((category) => {
                            const { icon, label } = CATEGORY_LABELS[category];
                            const count = getTemplatesByCategory(category).length;

                            return (
                                <TabsTrigger className="gap-2" disabled={count === 0} key={category} value={category}>
                                    {icon}
                                    <span className="hidden sm:inline">{i18n._(label)}</span>
                                    {count > 0 && (
                                        <Badge className="ml-1 size-5 justify-center p-0" variant="secondary">
                                            {count}
                                        </Badge>
                                    )}
                                </TabsTrigger>
                            );
                        })}
                    </TabsList>

                    {categories.map((category) => (
                        <TabsContent className="mt-4" key={category} value={category}>
                            <ScrollArea className="h-[400px] pr-4">
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    {getTemplatesByCategory(category).map((template) => (
                                        <TemplateCard key={template.id} onSelect={handleSelect} template={template} />
                                    ))}
                                    {getTemplatesByCategory(category).length === 0 && (
                                        <div className="text-muted-foreground col-span-2 flex h-32 items-center justify-center">
                                            <Trans>No templates available for this category yet.</Trans>
                                        </div>
                                    )}
                                </div>
                            </ScrollArea>
                        </TabsContent>
                    ))}
                </Tabs>
            </DialogContent>
        </Dialog>
    );
};

export default TemplatePicker;
