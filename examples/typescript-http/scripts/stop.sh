#!/bin/sh
set -eu

case "${VEYOPS_DEMO_ENV:-}" in
  test|staging) ;;
  *) echo 'VEYOPS_DEMO_ENV must be test or staging' >&2; exit 1 ;;
esac
release_dir=$(pwd -P)
deploy_dir=$(cd "$release_dir/../.." && pwd -P)
case "$release_dir" in
  "$deploy_dir"/releases/*) ;;
  *) echo 'Run this script from a veyops release directory' >&2; exit 1 ;;
esac
state="$deploy_dir/.typescript-$VEYOPS_DEMO_ENV/process"
if [ ! -f "$state" ]; then exit 0; fi
{
  IFS= read -r pid
  IFS= read -r entrypoint
} <"$state"
case "$pid" in ''|*[!0-9]*) echo 'Invalid fixture PID' >&2; exit 1 ;; esac
case "$entrypoint" in
  "$deploy_dir"/releases/*/server.js) ;;
  *) echo 'Invalid fixture entrypoint' >&2; exit 1 ;;
esac

ours() {
  [ -r "/proc/$pid/cmdline" ] &&
    [ "$(stat -c %u "/proc/$pid" 2>/dev/null)" = "$(id -u)" ] &&
    [ "$( (tr '\000' '\n' <"/proc/$pid/cmdline") 2>/dev/null | sed -n '2p')" = "$entrypoint" ]
}
if ours; then
  kill -TERM "$pid" 2>/dev/null || true
  attempts=0
  while ours && [ "$attempts" -lt 20 ]; do
    sleep 0.2
    attempts=$((attempts + 1))
  done
  if ours; then echo 'The previous fixture process did not stop' >&2; exit 1; fi
fi
rm -f "$state"
