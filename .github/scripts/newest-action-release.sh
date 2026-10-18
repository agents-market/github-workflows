#!/usr/bin/env bash
# Prints the SHA of the newest pipeline-action release on stdout.
#
# "Newest" is the tag whose commit has the latest date, not the tag that sorts
# last by name: in that repo v1.0.0 was cut on 17 September while v0.4.4 is from
# 2 October, so a name sort picks a three-week-old build and calls it an update.
#
# Two callers: the guard in smoke.yml (fails when ai-review.yml is behind) and
# the bumper in bump-action-pin.yml (updates it). They must agree on what
# "newest" means — a bumper that resolves a different release than the guard
# checks is worse than no bumper, so this lives in one place.
set -euo pipefail

REPO=agents-market/pipeline-action

newest_tag=''
newest_date=''
for tag in $(gh api --paginate "repos/$REPO/tags" --jq '.[].name'); do
  date=$(gh api "repos/$REPO/commits/$tag" --jq .commit.author.date)
  if [ -z "$newest_date" ] || [ "$date" \> "$newest_date" ]; then
    newest_tag=$tag
    newest_date=$date
  fi
done

[ -n "$newest_tag" ] || { echo "no tags found in $REPO" >&2; exit 1; }

gh api "repos/$REPO/commits/$newest_tag" --jq .sha
echo "newest release $newest_tag ($newest_date)" >&2