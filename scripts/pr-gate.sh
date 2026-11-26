#!/usr/bin/env bash
# Summarises a pull request's merge gate in one screen: head and mergeability, merge-queue position, check states (failing and
# pending ones named), unresolved review threads, and the latest Qodo review's findings. Each file a finding cites is checked at
# the PR's head, so a finding about code that was since removed reads as stale without opening it.
#
# Usage: scripts/pr-gate.sh <pr-number> [owner/repo]   (defaults to anolilab/neore)
set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "usage: scripts/pr-gate.sh <pr-number> [owner/repo]" >&2
    exit 2
fi

number="$1"
repo="${2:-anolilab/neore}"
owner="${repo%%/*}"
name="${repo##*/}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

gh api "repos/$repo/pulls/$number" >"$work/pr.json" 2>/dev/null
gh api graphql -F owner="$owner" -F name="$name" -F number="$number" -f query='
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    isInMergeQueue mergeQueueEntry{ position }
    reviewThreads(first:100){ nodes{ isResolved path } }
    comments(last:100){ nodes{ author{ login } createdAt body } }
  } } }' >"$work/graph.json"
gh pr checks "$number" --repo "$repo" >"$work/checks.tsv" 2>/dev/null || true

python3 -I - "$work/pr.json" "$work/graph.json" "$work/checks.tsv" "$repo" <<'PY'
import html, json, re, subprocess, sys

pr_path, graph_path, checks_path, repo = sys.argv[1:5]
pr = json.load(open(pr_path))
graph = json.load(open(graph_path))["data"]["repository"]["pullRequest"]
checks = [line.split("\t") for line in open(checks_path).read().splitlines() if "\t" in line]
head = pr["head"]["sha"]

print(f"PR #{pr['number']}  {pr['title'][:80]}")
print(f"  head {head[:10]}  base {pr['base']['ref']}  state {pr['state']}  merged {pr['merged']}")
queue = graph.get("mergeQueueEntry")
print(f"  merge queue: {'position ' + str(queue['position']) if queue else 'not queued'}")

states = {}
for row in checks:
    states.setdefault(row[1], []).append(row[0])
print("  checks: " + (", ".join(f"{k} {len(v)}" for k, v in sorted(states.items())) or "none reported"))
for label in ("fail", "pending"):
    names = states.get(label, [])
    if names:
        print(f"    {label}: " + "; ".join(names[:8]) + (" ..." if len(names) > 8 else ""))

open_threads = [t for t in graph["reviewThreads"]["nodes"] if not t["isResolved"]]
print(f"  unresolved review threads: {len(open_threads)}")

def plain(text):
    return html.unescape(re.sub(r"<[^>]+>", "", text))


# The newest Qodo review that lists findings: a summary or a "busy" post lists none.
qodo = [
    c
    for c in graph["comments"]["nodes"]
    if c["author"]
    and c["author"]["login"].startswith("qodo")
    and "Code Review by Qodo" in c["body"]
    and re.search(r"^\s*\d+\.\s+.*(🐞|✓)", plain(c["body"]), re.MULTILINE)
]
if not qodo:
    print("  latest Qodo review: none found")
    sys.exit(0)

latest = max(qodo, key=lambda c: c["createdAt"])
body = plain(latest["body"])
print(f"  latest Qodo review ({latest['createdAt'][:10]}): {body.count('⭐ New')} marked ⭐ New")

for line in body.split("\n"):
    m = re.match(r"\s*(\d+)\.\s+(.*?)\s*$", line)
    if m and ("🐞" in m.group(2) or "✓" in m.group(2)):
        title = m.group(2)
        mark = " [NEW]" if "⭐ New" in title else ""
        print(f"    {m.group(1)}. {title.replace('⭐ New', '').strip()}{mark}")

cited = sorted({m for m in re.findall(r"\[((?:backend|apps|packages|services|scripts)/[\w./-]+\.\w+)(?:\[R[\d-]+\])?\]", body)})
if cited:
    print("  cited files at head:")
    for path in cited[:20]:
        probe = subprocess.run(
            ["gh", "api", f"repos/{repo}/contents/{path}?ref={head}", "--silent"],
            capture_output=True,
        )
        print(f"    {'present' if probe.returncode == 0 else 'GONE   '} {path}")
PY
