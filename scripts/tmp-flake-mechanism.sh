#!/bin/bash
# TEMPORARY probe for the item e2e-git-tmp-flake-study; removed before the branch is ready.
# Git alone: one loop adds a new file (so one new loose object) per iteration; a second loop packs and prunes the loose
# objects (the work git's background maintenance does) while the first runs. Prints how many adds failed with the
# error of the e2e failures. With the second loop off, no add may fail.
set -u
seconds=${1:-20}
for packer in off on; do
  d=$(mktemp -d); cd "$d"; git init -q .; git config gc.auto 0; git config maintenance.auto false
  : > stop; rm stop
  if [ "$packer" = on ]; then ( while [ ! -f stop ]; do git repack -d -q 2>/dev/null; done ) & pid=$!; fi
  adds=0; enoent=0; other=0; end=$((SECONDS + seconds))
  while [ $SECONDS -lt $end ]; do
    adds=$((adds + 1)); echo "file $adds $RANDOM $RANDOM" > "f$adds"
    if ! git add "f$adds" 2> err.txt; then
      if grep -q 'unable to create temporary file' err.txt; then enoent=$((enoent + 1)); else other=$((other + 1)); head -2 err.txt; fi
    fi
  done
  touch stop; [ "$packer" = on ] && wait "$pid"
  echo "packer=$packer adds=$adds enoent=$enoent other=$other"
  cd /; rm -rf "$d"
done
