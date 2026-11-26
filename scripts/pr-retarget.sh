#!/usr/bin/env bash
# Retargets a pull request to a new base branch, then merges that base into the PR's branch, locally. Use it when a stacked
# PR's parent has merged into main: the PR moves onto the new base and picks up what the merge brought in.
#
# It does not push. Review the merge, then push the branch yourself.
#
# Usage: scripts/pr-retarget.sh <pr-number> <new-base> [owner/repo]   (defaults to anolilab/neore)
set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "usage: scripts/pr-retarget.sh <pr-number> <new-base> [owner/repo]" >&2
    exit 2
fi

number="$1"
base="$2"
repo="${3:-anolilab/neore}"

head_ref=$(gh api "repos/$repo/pulls/$number" --jq .head.ref 2>/dev/null)
current=$(git symbolic-ref --quiet --short HEAD || true)

if [ "$current" != "$head_ref" ]; then
    echo "pr-retarget: PR #$number's branch is '$head_ref', but this checkout is on '${current:-a detached HEAD}'. Switch to it first." >&2
    exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "pr-retarget: the working tree has uncommitted changes. Commit or set them aside first." >&2
    exit 1
fi

gh pr edit "$number" --repo "$repo" --base "$base" >/dev/null
echo "retargeted #$number to $base"

git fetch --quiet origin "$base"
if git merge --no-edit "origin/$base"; then
    echo "merged origin/$base into $head_ref (not pushed)"
else
    echo "pr-retarget: the merge of origin/$base stopped on conflicts. Resolve them, commit, then push." >&2
    exit 1
fi
