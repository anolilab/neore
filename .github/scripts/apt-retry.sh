#!/usr/bin/env bash
# Runs `apt-get update` and then the given command, up to three attempts. A mirror
# timeout (azure.archive.ubuntu.com) fails a whole job otherwise. The apt config
# also reaches apt calls made by other tools, e.g. `playwright install-deps`.
#
#   .github/scripts/apt-retry.sh sudo apt-get install -y libdbus-1-dev pkg-config
# errexit: a failed config write stops the script. The retried apt calls run inside an
# `if`, which errexit leaves alone, so a mirror failure is still retried.
set -euo pipefail

if [ "$#" -eq 0 ]; then
    echo "usage: apt-retry.sh <command...>" >&2
    exit 2
fi

echo 'Acquire::Retries "3";' | sudo tee /etc/apt/apt.conf.d/80-retries >/dev/null

for attempt in 1 2 3; do
    if sudo apt-get update && "$@"; then
        exit 0
    fi
    echo "apt attempt ${attempt}/3 failed" >&2
    if [ "$attempt" -lt 3 ]; then
        sleep $((attempt * 10))
    fi
done

exit 1
