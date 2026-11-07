#!/usr/bin/env sh
# Formats the root files no project owns: root code and data files and the
# `.github` config. Usage: oxfmt-root.sh --check | --write
#
# The list comes from git because oxfmt matches every glob argument
# recursively. It is read from a temp file, not a pipe, so a git failure or an
# empty list stops here: xargs would otherwise run oxfmt with no paths, and
# oxfmt with no paths formats the whole tree.
case "$1" in
    --check | --write) ;;
    *) echo "usage: $0 --check | --write" >&2; exit 2 ;;
esac
cd "$(git rev-parse --show-toplevel)" || exit 1
list=$(mktemp) || exit 1
trap 'rm -f "$list"' EXIT
trap 'exit 130' INT TERM HUP
git ls-files -z -- \
    ':(glob)*.json' ':(glob)*.yml' ':(glob)*.yaml' ':(glob)*.js' ':(glob)*.mjs' ':(glob)*.cjs' ':(glob)*.ts' \
    ':(glob).github/**/*.json' ':(glob).github/**/*.yml' ':(glob).github/**/*.yaml' \
    ':(glob).github/**/*.js' ':(glob).github/**/*.mjs' ':(glob).github/**/*.cjs' ':(glob).github/**/*.ts' \
    >"$list" || exit 1
[ -s "$list" ] || { echo "oxfmt-root: git listed no root files" >&2; exit 1; }
xargs -0 oxfmt "$1" -- <"$list"
