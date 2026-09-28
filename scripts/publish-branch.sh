#!/usr/bin/env bash
# Publishes a built release folder (scripts/publish-setup.mjs) as one new
# commit on the release branch, on top of the last release. A copy made with
# git clone ("Open in Cloud Shell") then takes the next release with a plain
# git pull. Found live: force-pushing a fresh branch each time made git pull
# refuse ("divergent branches"), and the old setup kept running.
#
# Usage: publish-branch.sh <folder> <remote url> <version>
set -euo pipefail
folder="$(cd "$1" && pwd)"
remote="$2"
version="$3"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if ! git clone -q --depth 1 --branch release "$remote" "$work/branch" 2>/dev/null; then
  # The very first release: no branch yet.
  rm -rf "$work/branch"
  git init -q "$work/branch"
  git -C "$work/branch" checkout -q -b release
  git -C "$work/branch" remote add origin "$remote"
fi

# The files go out byte for byte, whatever this machine's git settings.
git -C "$work/branch" config core.autocrlf false
# Exactly the new release: everything but the history is replaced.
find "$work/branch" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$folder"/. "$work/branch"/
git -C "$work/branch" add -A
git -C "$work/branch" -c user.name=release -c user.email=release@users.noreply.github.com commit -q -m "Release $version"
git -C "$work/branch" push -q origin release
