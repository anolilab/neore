import { Link } from "expo-router";
import { useState } from "react";
import { AccessibilityInfo, FlatList, Pressable, Text, TextInput, View } from "react-native";

import { getClient } from "@/lib/lunora";
import { createProject, isWriteBlocked, writeErrorMessage } from "@/projects/projects-api";
import { useIsOffline, useProjects } from "@/projects/use-projects";

const ProjectsScreen = () => {
    const { error: loadError, rows } = useProjects();
    const isOffline = useIsOffline();
    const [name, setName] = useState("");
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const create = async () => {
        if (isWriteBlocked({ busy: creating, offline: isOffline })) {
            return;
        }

        setCreating(true);
        setError(null);

        try {
            const created = await createProject(getClient(), name);

            setName("");
            // The live list delivers the row itself; this tells a screen reader the tap did something.
            AccessibilityInfo.announceForAccessibility(`Project ${created.title} created`);
        } catch (error_: unknown) {
            const message = writeErrorMessage(error_);

            setError(message);
            AccessibilityInfo.announceForAccessibility(message);
        } finally {
            setCreating(false);
        }
    };

    const blocked = isWriteBlocked({ busy: creating, offline: isOffline });
    const shownError = error ?? loadError;

    return (
        <FlatList
            data={rows ?? []}
            keyExtractor={(project) => project.id}
            ListEmptyComponent={(
<>
{rows === undefined && !shownError ? <Text accessibilityRole="progressbar" style={{ padding: 16 }}>Loading projects...</Text> : null}
{rows === undefined ? null : <Text style={{ padding: 16 }}>No projects yet.</Text>}
</>
)}
            ListHeaderComponent={(
                <View style={{ gap: 8, padding: 16 }}>
                    <Text style={{ fontWeight: "600" }}>New project</Text>
                    <TextInput
                        accessibilityLabel="Project name"
                        editable={!blocked}
                        onChangeText={setName}
                        onSubmitEditing={create}
                        placeholder="Project name"
                        returnKeyType="done"
                        style={{ borderColor: "#ccc", borderRadius: 10, borderWidth: 1, padding: 10 }}
                        value={name}
                    />
                    <Pressable
                        accessibilityLabel="Create project"
                        accessibilityRole="button"
                        accessibilityState={{ busy: creating, disabled: blocked }}
                        disabled={blocked}
                        onPress={create}
                        style={{ opacity: blocked ? 0.5 : 1, padding: 12 }}
                    >
                        <Text style={{ fontWeight: "600" }}>{creating ? "Creating..." : "Create project"}</Text>
                    </Pressable>
                    {isOffline
                        ? <Text accessibilityRole="alert">You are offline. Creating a project needs a connection.</Text>
                        : null}
                    {shownError
                        ? <Text accessibilityRole="alert" style={{ color: "#b00020" }}>{shownError}</Text>
                        : null}
                </View>
            )}
            renderItem={({ item }) => (
                <Link asChild href={`/projects/${item.id}`}>
                    <Pressable accessibilityLabel={`Open project ${item.title}`} accessibilityRole="link" style={{ padding: 16 }}>
                        <Text numberOfLines={1} style={{ fontWeight: "600" }}>{item.title}</Text>
                        {item.description ? <Text numberOfLines={2}>{item.description}</Text> : null}
                    </Pressable>
                </Link>
            )}
        />
    );
};

export default ProjectsScreen;
