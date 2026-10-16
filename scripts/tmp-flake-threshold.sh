#!/bin/bash
# TEMPORARY probe for the item e2e-git-tmp-flake-study; removed before the branch is ready.
# How many new loose objects make `git commit` start background maintenance? Commits of growing size in one fresh
# repository; after each, waits for background work to end and prints the loose objects and packs before and after.
set -u
d=$(mktemp -d); cd "$d"; git init -q -b main .; mkdir items
git config --show-origin --get-regexp 'gc|maint' || echo "no gc or maintenance settings in any config file"
n=0
for k in 5 10 20 40 80 160 320 640 5 5 5; do
  for i in $(seq 1 "$k"); do n=$((n + 1)); printf 'id: %s\nbody: %s %s\n' "$n" "$RANDOM" "$RANDOM" > "items/f$n.yaml"; done
  git add -- items
  before=$(git count-objects -v | awk '/^count:/{c=$2} /^packs:/{p=$2} END{print "loose=" c " packs=" p}')
  GIT_TRACE2_EVENT="$d/t.json" git -c commit.gpgsign=false commit -q -m "add $k"
  for w in $(seq 1 100); do [ -e .git/gc.pid ] || break; sleep 0.1; done; sleep 0.4
  after=$(git count-objects -v | awk '/^count:/{c=$2} /^packs:/{p=$2} END{print "loose=" c " packs=" p}')
  repack=$(grep -c '"repack"' "$d/t.json"); rm -f "$d/t.json"
  echo "files=$k  after adding: $before  after the commit and its maintenance: $after  repack runs=$repack"
done
cd /; rm -rf "$d"
