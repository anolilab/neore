import { Link, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { AccessibilityInfo, FlatList, Pressable, Text } from "react-native";

import { getClient } from "@/lib/lunora";
import { isWriteBlocked, startProjectThread, writeErrorMessage } from "@/projects/projects-api";
import { useIsOffline, useProject, useProjectThreads } from "@/projects/use-projects";

const ProjectScreen = () => {
    const { projectId } = useLocalSearchParams<{ projectId: string }>();
    const router = useRouter();
    const { error: projectError, rows: projectRows } = useProject(projectId);
    const { error: loadError, rows: threads } = useProjectThreads(projectId);
    const isOffline = useIsOffline();
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Read by id: the list is capped at 100 and empty until it answers, and the server prefers the model sent here over the project's own.
    const project = projectRows?.[0];

    const startThread = async () => {
        if (!project || isWriteBlocked({ busy: starting, offline: isOffline })) {
            return;
        }

        setStarting(true);
        setError(null);

        try {
            const threadId = await startProjectThread(getClient(), { defaultModel: project.defaultModel, id: projectId });

            router.push(`/chat/${threadId}`);
        } catch (error_: unknown) {
            const message = writeErrorMessage(error_);

            setError(message);
            AccessibilityInfo.announceForAccessibility(message);
        } finally {
            setStarting(false);
        }
    };

    const blocked = isWriteBlocked({ busy: starting, offline: isOffline }) || !project;
    const shownError = error ?? projectError ?? (projectRows?.length === 0 ? "This project is not available." : undefined) ?? loadError;

    return (
        <>
            <Stack.Screen options={{ title: project?.title ?? "Project" }} />
            <FlatList
                data={threads ?? []}
                keyExtractor={(thread) => thread.id}
                ListEmptyComponent={(
<>
{threads === undefined && !shownError ? <Text accessibilityRole="progressbar" style={{ padding: 16 }}>Loading chats...</Text> : null}
{threads === undefined ? null : <Text style={{ padding: 16 }}>No chats in this project yet.</Text>}
</>
)}
                ListHeaderComponent={(
                    <>
                        <Pressable
                            accessibilityLabel="New chat in this project"
                            accessibilityRole="button"
                            accessibilityState={{ busy: starting, disabled: blocked }}
                            disabled={blocked}
                            onPress={startThread}
                            style={{ opacity: blocked ? 0.5 : 1, padding: 16 }}
                        >
                            <Text style={{ fontWeight: "600" }}>{starting ? "Starting..." : "New chat in this project"}</Text>
                        </Pressable>
                        {isOffline ? <Text accessibilityRole="alert" style={{ paddingHorizontal: 16 }}>You are offline. Starting a chat needs a connection.</Text> : null}
                        {shownError ? <Text accessibilityRole="alert" style={{ color: "#b00020", padding: 16 }}>{shownError}</Text> : null}
                    </>
                )}
                renderItem={({ item }) => (
                    <Link asChild href={`/chat/${item.id}`}>
                        <Pressable accessibilityLabel={`Open chat ${item.title}`} accessibilityRole="link" style={{ padding: 16 }}>
                            <Text numberOfLines={1}>{item.title}</Text>
                        </Pressable>
                    </Link>
                )}
            />
        </>
    );
};

export default ProjectScreen;
