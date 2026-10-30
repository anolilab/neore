import { describe, expect, it } from "vitest";

import type { DeclaredHost, RepoIdentity } from "./identity";
import { parseRepoRemote } from "./identity";

const GHES: DeclaredHost = { hostKind: "github", origin: "https://ghe.example.com" };
const GITLAB_SELF: DeclaredHost = { hostKind: "gitlab", origin: "https://git.corp.example:8443" };
const FORGEJO_SUBPATH: DeclaredHost = { basePath: "/git/", hostKind: "forgejo", origin: "https://example.com" };
const FORGEJO_ROOT: DeclaredHost = { hostKind: "forgejo", origin: "https://example.com" };

const identity = (hostKind: RepoIdentity["hostKind"], origin: string, path: string): RepoIdentity => {
    return { hostKind, origin, path };
};

describe("parseRepoRemote", () => {
    describe.each<[string, string, DeclaredHost[], RepoIdentity]>([
        // GitHub
        ["scp SSH", "git@github.com:octo/hello.git", [], identity("github", "https://github.com", "octo/hello")],
        ["scp SSH without .git", "git@github.com:octo/hello", [], identity("github", "https://github.com", "octo/hello")],
        ["scp SSH without a user", "github.com:octo/hello.git", [], identity("github", "https://github.com", "octo/hello")],
        ["ssh:// URL", "ssh://git@github.com/octo/hello.git", [], identity("github", "https://github.com", "octo/hello")],
        ["ssh over 443", "ssh://git@ssh.github.com:443/octo/hello.git", [], identity("github", "https://github.com", "octo/hello")],
        ["HTTPS", "https://github.com/octo/hello", [], identity("github", "https://github.com", "octo/hello")],
        ["HTTPS with .git and a trailing slash", "https://github.com/octo/hello.git/", [], identity("github", "https://github.com", "octo/hello")],
        ["HTTPS with the host in capitals", "https://GitHub.com/octo/hello", [], identity("github", "https://github.com", "octo/hello")],
        ["HTTPS with credentials (dropped)", "https://user:ghp_secret@github.com/octo/hello.git", [], identity("github", "https://github.com", "octo/hello")],
        ["a web address of a pull request", "https://github.com/octo/hello/pull/12", [], identity("github", "https://github.com", "octo/hello")],
        ["a name with dots and dashes", "https://github.com/octo-org/hello.world.js", [], identity("github", "https://github.com", "octo-org/hello.world.js")],
        // ports
        [
            "an SSH port is not the web port",
            "ssh://git@ghe.example.com:2222/octo/hello.git",
            [GHES],
            identity("github", "https://ghe.example.com", "octo/hello"),
        ],
        [
            "an HTTPS port is part of the origin",
            "https://git.corp.example:8443/platform/api.git",
            [GITLAB_SELF],
            identity("gitlab", "https://git.corp.example:8443", "platform/api"),
        ],
        [
            "a declared origin answers an SSH remote on another port",
            "ssh://git@git.corp.example:2222/platform/api.git",
            [GITLAB_SELF],
            identity("gitlab", "https://git.corp.example:8443", "platform/api"),
        ],
        ["a default port is dropped", "https://github.com:443/octo/hello", [], identity("github", "https://github.com", "octo/hello")],
        // GitLab
        ["GitLab", "https://gitlab.com/acme/api.git", [], identity("gitlab", "https://gitlab.com", "acme/api")],
        ["GitLab subgroups", "git@gitlab.com:acme/platform/backend/api.git", [], identity("gitlab", "https://gitlab.com", "acme/platform/backend/api")],
        [
            "a GitLab merge request address",
            "https://gitlab.com/acme/platform/api/-/merge_requests/7",
            [],
            identity("gitlab", "https://gitlab.com", "acme/platform/api"),
        ],
        // Forgejo / Gitea
        ["Codeberg", "https://codeberg.org/forgejo/forgejo.git", [], identity("forgejo", "https://codeberg.org", "forgejo/forgejo")],
        ["Forgejo declared at the root", "git@example.com:team/app.git", [FORGEJO_ROOT], identity("forgejo", "https://example.com", "team/app")],
        ["Forgejo under a URL subpath", "https://example.com/git/team/app.git", [FORGEJO_SUBPATH], identity("forgejo", "https://example.com", "team/app")],
        // Bitbucket
        ["Bitbucket", "https://bitbucket.org/workspace/repo.git", [], identity("bitbucket", "https://bitbucket.org", "workspace/repo")],
        [
            "Bitbucket with a user name in the URL",
            "https://dev@bitbucket.org/workspace/repo.git",
            [],
            identity("bitbucket", "https://bitbucket.org", "workspace/repo"),
        ],
        ["Bitbucket SSH", "git@bitbucket.org:workspace/repo.git", [], identity("bitbucket", "https://bitbucket.org", "workspace/repo")],
        // Azure DevOps
        ["Azure HTTPS", "https://dev.azure.com/contoso/Web/_git/site", [], identity("azure", "https://dev.azure.com", "contoso/Web/site")],
        [
            "Azure HTTPS with the organization as the user",
            "https://contoso@dev.azure.com/contoso/Web/_git/site",
            [],
            identity("azure", "https://dev.azure.com", "contoso/Web/site"),
        ],
        [
            "Azure with a space in the project",
            "https://dev.azure.com/contoso/My%20Project/_git/site",
            [],
            identity("azure", "https://dev.azure.com", "contoso/My Project/site"),
        ],
        [
            "Azure with the project named after the repository",
            "https://dev.azure.com/contoso/_git/site",
            [],
            identity("azure", "https://dev.azure.com", "contoso/site/site"),
        ],
        ["Azure SSH", "git@ssh.dev.azure.com:v3/contoso/Web/site", [], identity("azure", "https://dev.azure.com", "contoso/Web/site")],
        ["Azure legacy host", "https://contoso.visualstudio.com/Web/_git/site", [], identity("azure", "https://contoso.visualstudio.com", "contoso/Web/site")],
        [
            "Azure legacy host with DefaultCollection",
            "https://contoso.visualstudio.com/DefaultCollection/Web/_git/site",
            [],
            identity("azure", "https://contoso.visualstudio.com", "contoso/Web/site"),
        ],
        ["Azure legacy SSH", "contoso@vs-ssh.visualstudio.com:v3/contoso/Web/site", [], identity("azure", "https://dev.azure.com", "contoso/Web/site")],
        [
            "Azure pull request address",
            "https://dev.azure.com/contoso/Web/_git/site/pullrequest/5",
            [],
            identity("azure", "https://dev.azure.com", "contoso/Web/site"),
        ],
    ])("%s", (_name, remote, declared, expected) => {
        it("parses", () => {
            expect(parseRepoRemote(remote, declared)).toEqual(expected);
        });
    });

    describe("host kind is declared, never guessed", () => {
        it("reads an undeclared custom domain as unknown, even when its name says otherwise", () => {
            expect(parseRepoRemote("https://gitlab.corp.example/acme/api.git")).toEqual(identity("unknown", "https://gitlab.corp.example", "acme/api"));
            expect(parseRepoRemote("git@github.corp.example:octo/hello.git")).toEqual(identity("unknown", "https://github.corp.example", "octo/hello"));
        });

        it("does not read a known domain on another port as that service", () => {
            expect(parseRepoRemote("https://github.com:8443/octo/hello")).toEqual(identity("unknown", "https://github.com:8443", "octo/hello"));
        });

        it("takes the declared kind, whatever the name", () => {
            expect(parseRepoRemote("https://gitlab.corp.example/acme/api.git", [{ hostKind: "forgejo", origin: "https://gitlab.corp.example" }])).toEqual(
                identity("forgejo", "https://gitlab.corp.example", "acme/api"),
            );
        });

        it("does not apply a declaration to another origin on the same host", () => {
            expect(parseRepoRemote(["http", "://ghe.example.com/octo/hello"].join(""), [GHES])).toEqual(
                identity("unknown", ["http", "://ghe.example.com"].join(""), "octo/hello"),
            );
        });

        it("prefers the longest matching subpath", () => {
            const declared: DeclaredHost[] = [FORGEJO_ROOT, { basePath: "git", hostKind: "gitlab", origin: "https://example.com" }];

            expect(parseRepoRemote("https://example.com/git/team/app", declared)?.hostKind).toBe("gitlab");
            expect(parseRepoRemote("https://example.com/team/app", declared)?.hostKind).toBe("forgejo");
        });

        it("ignores a declaration whose origin is not a URL", () => {
            expect(parseRepoRemote("https://github.com/octo/hello", [{ hostKind: "gitlab", origin: "not a url" }])?.hostKind).toBe("github");
        });
    });

    describe.each([
        ["an empty string", ""],
        ["whitespace", " ".repeat(3)],
        ["a bare name", "hello"],
        ["owner/repo with no host", "octo/hello"],
        ["a host with no repository", "https://github.com/"],
        ["one segment", "https://github.com/octo"],
        ["a GitLab project with no group", "https://gitlab.com/api"],
        ["a query", "https://github.com/octo/hello?tab=readme"],
        ["a fragment", "https://github.com/octo/hello#readme"],
        ["a dot segment", "https://github.com/octo/../hello"],
        ["an encoded dot segment", "https://github.com/octo/%2e%2e"],
        ["an encoded slash", "https://github.com/octo%2Fx/hello"],
        ["a backslash", String.raw`https://github.com/octo\x/hello`],
        ["a space in a remote", "git@github.com:octo/hel lo.git"],
        ["a file URL", "file:///srv/repos/hello.git"],
        ["a script URL", ["java", "script:alert(1)//github.com/octo/hello"].join("")],
        ["a broken percent escape", "https://github.com/octo/%zz"],
        ["Azure with no repository", "https://dev.azure.com/contoso/Web"],
        ["Azure SSH with a short path", "git@ssh.dev.azure.com:v3/contoso/Web"],
        ["a newline", "https://github.com/octo/hello\nhttps://evil.example/x"],
        ["an oversized string", `https://github.com/${"a".repeat(3000)}/b`],
    ])("rejects %s", (_name, remote) => {
        it("returns null", () => {
            expect(parseRepoRemote(remote)).toBeNull();
        });
    });
});
