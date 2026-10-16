#!/bin/bash
# TEMPORARY probe for the item e2e-git-tmp-flake-study; removed before the branch is ready.
# Git alone: four writers each store one new loose object per iteration (git hash-object -w uses the same
# loose-object write as git add), while a second loop runs the repack that git's automatic maintenance ran in the e2e
# seeds. Prints how many writes failed with the error of the e2e failures. With the repack loop off, none may fail.
set -u
seconds=${1:-60}; packer=${2:-on}
d=$(mktemp -d); cd "$d"; git init -q .; git config gc.auto 0; git config maintenance.auto false
echo seed | git hash-object -w --stdin > /dev/null
if [ "$packer" = on ]; then
  ( while [ ! -f "$d/stop" ]; do git repack -d -l --cruft --cruft-expiration=2.weeks.ago --write-midx -q 2> /dev/null; done ) & pack=$!
fi
writer() {
  n=0; f=0; o=0; end=$((SECONDS + seconds))
  while [ $SECONDS -lt $end ]; do
    n=$((n + 1))
    if ! echo "$1 $n $RANDOM $RANDOM" | git hash-object -w --stdin > /dev/null 2> "$d/e$1"; then
      if grep -q 'unable to create temporary file' "$d/e$1"; then f=$((f + 1)); else o=$((o + 1)); head -2 "$d/e$1"; fi
    fi
  done
  echo "packer=$packer writer $1: writes=$n enoent=$f other=$o"
}
pids=""; for w in 1 2 3 4; do writer "$w" & pids="$pids $!"; done
wait $pids
touch "$d/stop"; [ "$packer" = on ] && wait "$pack"
cd /; rm -rf "$d"
