#!/usr/bin/env bash
# One CI pass of ClarifyDoc over a change: analyze the base commit (once per
# base — reuse $CD_OUT/base when it is already there), seed the head from it so
# only the changed files reparse, gate on what the change introduced, and write
# a pull-request comment. Used by the GitHub Action (../action.yml) and the
# GitLab template (gitlab-ci.yml); runs in any CI with git and Node 24.
#
#   CD_CLI          path to the CLI's dist/cli.js
#   CD_OUT          working directory for the analyses (base/, head/, reports)
#   CD_PATH         project to analyze, relative to the repository root (default .)
#   CD_BASE_SHA     the commit to compare with; empty = no baseline, every finding counts
#   CD_FAIL_ON      `analyze --fail-on` gate (a level and/or finding categories); empty = none
#   CD_FAIL_ON_API  `diff --fail-on` gate for the API surface (breaking | risky); empty = none
#   CD_ARGS         further `analyze` options, word-split (e.g. "--coverage coverage/lcov.info")
#
# Writes $CD_OUT/head.sarif, findings.junit.xml, codequality.json, comment.md.
# Exit 2 when a gate tripped, 1 when the analysis failed, else 0.
set -euo pipefail

: "${CD_CLI:?CD_CLI must name dist/cli.js}" "${CD_OUT:?CD_OUT must name a working directory}"
repo="$(git rev-parse --show-toplevel)"
root="$(cd "$repo/${CD_PATH:-.}" && pwd -P)"
rel="${root#"$(cd "$repo" && pwd -P)"}"
rel="${rel#/}"
name="$(basename "$root")"
out="$(mkdir -p "$CD_OUT" && cd "$CD_OUT" && pwd -P)"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
gate=0

base=""
if [ -n "${CD_BASE_SHA:-}" ]; then
  base="$out/base/$name"
  if [ ! -f "$base/project-summary.json" ]; then
    git -C "$repo" cat-file -e "${CD_BASE_SHA}^{commit}" 2>/dev/null \
      || git -C "$repo" fetch --no-tags --depth=1 origin "$CD_BASE_SHA"
    # The worktree's project folder must carry the head's name: the analysis is filed under it.
    wt="$out/worktree/$(basename "$repo")"
    rm -rf "$out/worktree"
    git -C "$repo" worktree add --detach --force "$wt" "$CD_BASE_SHA" >/dev/null
    base_root="$wt${rel:+/$rel}"
    if [ -d "$base_root" ]; then
      echo "ClarifyDoc: analyzing the base ${CD_BASE_SHA:0:12}"
      node "$CD_CLI" analyze "$base_root" -o "$out/base" --no-lsp > "$out/base.log" 2>&1 || { cat "$out/base.log"; exit 1; }
    fi
    git -C "$repo" worktree remove --force "$wt"
    rm -rf "$out/worktree"
  fi
  if [ -f "$base/project-summary.json" ]; then
    # Seed the head: unchanged files are reused, only what the change touched reparses.
    rm -rf "$out/head"
    mkdir -p "$out/head"
    cp -R "$base" "$out/head/$name"
  else
    echo "ClarifyDoc: the base has no ${rel:-project} — every finding counts as new"
    base=""
  fi
fi

args=(analyze "$root" -o "$out/head" --no-lsp --incremental
  --sarif "$out/head.sarif" --junit "$out/findings.junit.xml" --codequality "$out/codequality.json")
[ -n "$base" ] && args+=(--baseline "$base")
[ -n "${CD_FAIL_ON:-}" ] && args+=(--fail-on "$CD_FAIL_ON")
# shellcheck disable=SC2206 # word-splitting is the point
[ -n "${CD_ARGS:-}" ] && args+=($CD_ARGS)
set +e
node "$CD_CLI" "${args[@]}"
code=$?
set -e
if [ "$code" -eq 2 ]; then gate=1; elif [ "$code" -ne 0 ]; then exit 1; fi

: > "$out/api.md"
if [ -n "$base" ]; then
  dargs=(diff "$base" "$out/head/$name" --md)
  [ -n "${CD_FAIL_ON_API:-}" ] && dargs+=(--fail-on "$CD_FAIL_ON_API")
  set +e
  node "$CD_CLI" "${dargs[@]}" > "$out/api.md"
  code=$?
  set -e
  if [ "$code" -eq 2 ]; then gate=1; elif [ "$code" -ne 0 ]; then exit 1; fi
fi

node "$here/comment.mjs" "$out/head.sarif" "$out/api.md" "${CD_BASE_SHA:-}" "$gate" > "$out/comment.md"
[ "$gate" -eq 1 ] && exit 2
exit 0
