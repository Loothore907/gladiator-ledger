#!/bin/sh
# The image starts as root only to do one thing: make a freshly mounted state folder (a host's volume at /data)
# writable by the unprivileged user. Then it drops to that user for good. Started as any other user (for example
# by a cluster that forbids root), it runs as that user unchanged.
set -e
if [ "$(id -u)" = "0" ]; then
    if [ -d /data ]; then chown ledger /data 2>/dev/null || true; fi
    export HOME=/home/ledger
    exec setpriv --reuid ledger --regid ledger --init-groups ledger "$@"
fi
exec ledger "$@"
