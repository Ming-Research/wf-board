#!/bin/bash
# TEMPORARY probe for the item e2e-git-tmp-flake-study; removed before the branch is ready.
# The seed's git work without Node: a big first commit, then two smaller commits that change files of it, in a fresh
# repository, over and over for <seconds>. Prints how many rounds ran and how many failed with the error of the e2e
# failures. The caller sets git's configuration through GIT_CONFIG_COUNT and its keys.
set -u
seconds=${1:-60}; first=${2:-700}; second=${3:-40}
rounds=0; enoent=0; other=0; end=$((SECONDS + seconds))
while [ $SECONDS -lt $end ]; do
  d=$(mktemp -d); cd "$d"; git init -q -b main .; mkdir items
  for i in $(seq 1 "$first"); do printf 'id: %s\nbody: %s %s %s\n' "$i" "$RANDOM" "$RANDOM" "$RANDOM" > "items/f$i.yaml"; done
  git add -- items && git -c commit.gpgsign=false commit -q -m one
  for step in 2 3; do
    paths=(); for i in $(seq "$step" $((first / second)) "$first"); do paths+=("items/f$i.yaml"); printf 'more: %s\n' "$RANDOM" >> "items/f$i.yaml"; done
    if ! git add -- "${paths[@]}" 2> err.txt; then
      if grep -q 'unable to create temporary file' err.txt; then enoent=$((enoent + 1)); else other=$((other + 1)); head -2 err.txt; fi
      break
    fi
    git -c commit.gpgsign=false commit -q -m "step $step"
  done
  rounds=$((rounds + 1)); sleep 0.3; cd /; rm -rf "$d"
done
echo "rounds=$rounds enoent=$enoent other=$other"
