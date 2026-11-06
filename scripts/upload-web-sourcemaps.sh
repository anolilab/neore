#!/usr/bin/env bash
# Upload the web build's source maps to PostHog, then delete every map from apps/web/dist.
#
# `vite build` writes a source map for every client and server chunk (`sourcemap: "hidden"`):
# 2,700 files and ~118 MiB in dist/client alone, about two thirds of what the Worker uploads as
# static assets, all of it publicly served. They belong in PostHog, which maps a browser stack
# trace back to the source through the `//# chunkId=` comment `inject` adds to each chunk, so:
# inject + upload (client only; a Worker stack trace has no chunk to look up), then delete every
# map before Alchemy uploads the directory. One build makes both the chunks and the maps, so they
# cannot disagree. The CLI is pinned with its checksum rather than installed from npm, whose
# installer runs a download script and does not verify it. Without a key the maps are still
# deleted, and a failed upload warns instead of failing a deploy over an error-tracking nicety.
#
# Reads POSTHOG_CLI_API_KEY, POSTHOG_CLI_PROJECT_ID, VITE_POSTHOG_HOST, RELEASE_VERSION,
# RELEASE_BUILD and RUNNER_TEMP.
set -euo pipefail

if [[ -z "${POSTHOG_CLI_API_KEY:-}" || -z "${POSTHOG_CLI_PROJECT_ID:-}" ]]; then
    echo "::notice::POSTHOG_CLI_API_KEY / POSTHOG_PROJECT_ID are not set on this environment: the source maps are deleted without being uploaded."
else
    # The CLI talks to the app host (eu.posthog.com), events go to eu.i.posthog.com.
    host="${VITE_POSTHOG_HOST:-}"
    export POSTHOG_CLI_HOST="${host/.i./.}"

    version="0.18.10"
    sha256="29f2d4409f08205bab7d52f9cc919e964ea2c867ec568b3acdd9ee3eb4149c3d"
    archive="posthog-cli-x86_64-unknown-linux-gnu.tar.gz"

    # Only the checksum is fail-closed: a CLI we cannot trust must not run. A failed
    # download or extraction, like a failed upload, must not skip the cleanup below.
    if ! curl --fail --silent --show-error --location --output "$RUNNER_TEMP/$archive" \
        "https://github.com/PostHog/posthog/releases/download/posthog-cli/v${version}/${archive}"; then
        echo "::warning::Downloading the PostHog CLI failed: the source maps are deleted without being uploaded."
    elif ! echo "${sha256}  $RUNNER_TEMP/$archive" | sha256sum --check --strict -; then
        echo "::error::The PostHog CLI checksum did not match."
        exit 1
    elif ! tar --extract --gzip --file "$RUNNER_TEMP/$archive" --directory "$RUNNER_TEMP"; then
        echo "::warning::Extracting the PostHog CLI failed: the source maps are deleted without being uploaded."
    elif ! "$RUNNER_TEMP/posthog-cli-x86_64-unknown-linux-gnu/posthog-cli" sourcemap process \
        --directory apps/web/dist/client \
        --release-name "neore-web" \
        --release-version "$RELEASE_VERSION" \
        --build "$RELEASE_BUILD" \
        --delete-after; then
        echo "::warning::Uploading the source maps to PostHog failed: browser errors from this deploy will not be un-minified."
    fi
fi

find apps/web/dist -name '*.map' -delete
