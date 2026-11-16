#!/bin/sh
set -eu

node_bin=${VEYOPS_NODE:-node}
release_dir=$(pwd -P)
deploy_dir=$(cd "$release_dir/../.." && pwd -P)
case "$release_dir" in
  "$deploy_dir"/releases/*) ;;
  *) echo 'Run this script from a veyops release directory' >&2; exit 1 ;;
esac
state_dir="$deploy_dir/.nestjs-fixture"
umask 077
mkdir -p "$state_dir"
sh "$release_dir/stop.sh"

export VEYOPS_DEMO_INSTANCE=${release_dir##*/}
nohup "$node_bin" "$release_dir/server.cjs" </dev/null >>"$state_dir/server.log" 2>&1 &
pid=$!
printf '%s\n%s\n' "$pid" "$release_dir/server.cjs" >"$state_dir/process"
if ! sh "$release_dir/health.sh"; then
  sh "$release_dir/stop.sh"
  exit 1
fi
