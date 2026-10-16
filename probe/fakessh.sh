#!/bin/sh
# Stands in for ssh: runs the remote command locally after a delay, or never answers.
#   PROBE_DELAY       seconds each connection takes before the command runs (default 0)
#   PROBE_STALL_ON    when the command contains this text, sleep for an hour instead
for last; do :; done
case "$last" in *"${PROBE_STALL_ON:-@@none@@}"*) exec sleep 3600 ;; esac
sleep "${PROBE_DELAY:-0}"
exec sh -c "$last"
