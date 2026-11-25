#!/bin/sh
set -eu
umask 077

# Use a local Linux Docker host. Only the labeled, temporary resources below
# are started or removed. The existing host Docker socket is never mounted.
revision=${1:?Pass the full candidate Git SHA}
database=${2:-sqlite}
mode=${3:-acceptance}
bind=${4:-}
case "$revision" in *[!a-f0-9]*) exit 2 ;; esac
test "${#revision}" -eq 40 || exit 2
case "$database" in sqlite|postgres) ;; *) printf '%s\n' 'Choose sqlite or postgres.' >&2; exit 2 ;; esac
case "$mode" in
  acceptance|flow-v2|flow-v2-image) test -z "$bind" ;;
  preview)
    if ! printf '%s\n' "$bind" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}:[1-9][0-9]{3,4}$' ||
       [ "${bind%:*}" = 0.0.0.0 ] || [ "${bind##*:}" -gt 65535 ]; then
      printf '%s\n' 'Preview requires a specific host IPv4 address and port.' >&2
      exit 2
    fi
    ;;
  *) printf '%s\n' 'Choose acceptance, flow-v2, flow-v2-image or preview.' >&2; exit 2 ;;
esac

repo=$(git rev-parse --show-toplevel)
test "$(git -C "$repo" rev-parse --verify "$revision^{commit}")" = "$revision"
if ! git -C "$repo" diff --quiet "$revision" -- tools/acceptance/p1-linux.sh; then
  printf '%s\n' 'Run the Linux harness from the candidate commit.' >&2
  exit 2
fi
candidate=${VEYOPS_ACCEPT_RUNTIME_IMAGE:?Set VeyOps candidate image built from the specified revision}
target_image=${VEYOPS_ACCEPT_ENGINE_IMAGE:-node:24-bookworm-slim}
site_image=busybox:1.36
postgres_image=${VEYOPS_ACCEPT_POSTGRES_IMAGE:-postgres:17-bookworm}
for image in "$candidate" "$target_image" "$postgres_image"; do
  case "$image" in ''|-*|*[!a-zA-Z0-9.:/@_-]*) printf '%s\n' 'Invalid fixture image reference.' >&2; exit 2 ;; esac
done
context_host=$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' "$(docker context show)")
for endpoint in "$context_host" "${DOCKER_HOST:-unix:///var/run/docker.sock}"; do
  case "$endpoint" in unix:///*) ;; *) printf '%s\n' 'Use a local Unix-socket Docker context.' >&2; exit 2 ;; esac
done
if [ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$candidate")" != "$revision" ]; then
  printf '%s\n' 'The candidate image revision label must match the supplied Git SHA.' >&2
  exit 2
fi
if [ "$(docker info --format '{{.OSType}}/{{.CgroupVersion}}')" != linux/2 ]; then
  printf '%s\n' 'This harness requires a local Linux Docker Engine using cgroup v2.' >&2
  exit 2
fi
docker image inspect "$target_image" "$site_image" >/dev/null
if [ "$database" = postgres ]; then docker image inspect "$postgres_image" >/dev/null; fi

work=$(mktemp -d /tmp/veyops-candidate-XXXXXX)
prefix=$(basename "$work")
network="$prefix-net"
preview_network="$prefix-preview"
manager="$prefix-api"
postgres="$prefix-db"
case "$mode" in
  flow-v2) targets='test-a test-b' ;;
  flow-v2-image) targets='test-a' ;;
  *) targets='test-a test-b production-a production-b' ;;
esac
cleanup() {
  status=$?
  trap - EXIT INT TERM
  for target in api db $targets; do
    name="$prefix-$target"
    if [ "$(docker inspect --type container --format '{{index .Config.Labels "veyops.acceptance"}}' "$name" 2>/dev/null || :)" = "$prefix" ]; then
      docker rm -fv "$name" >/dev/null || :
    fi
  done
  for name in "$network" "$preview_network"; do
    if [ "$(docker network inspect --format '{{index .Labels "veyops.acceptance"}}' "$name" 2>/dev/null || :)" = "$prefix" ]; then
      docker network rm "$name" >/dev/null || :
    fi
  done
  rm -f -- "$work/bootstrap.env" "$work/postgres.env" "$work/preview-login.txt"
  rm -f -- "$work/host-ssh/fixture-admin" "$work/host-ssh/test-a" "$work/host-ssh/test-b" \
    "$work/host-ssh/production-a" "$work/host-ssh/production-b"
  printf 'Candidate artifacts and logs: %s\n' "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git -C "$repo" archive "$revision" tools/acceptance examples/refactor-stage0 | tar -x -C "$work"
test -f "$work/tools/acceptance/refactor-demo.cjs"
test -f "$work/tools/acceptance/p1-delivery.cjs"
test -f "$work/tools/acceptance/target-start.sh"
mkdir -p "$work/bin" "$work/plugins" "$work/host-ssh" "$work/targets" "$work/app" "$work/repo"
for tool in dockerd docker containerd containerd-shim-runc-v2 runc; do
  source_path=$(command -v "$tool")
  cp -L -- "$source_path" "$work/bin/$tool"
done
dockerd_dir=$(dirname "$(command -v dockerd)")
proxy=$(command -v docker-proxy || :)
if [ -z "$proxy" ]; then
  for path in "$dockerd_dir/docker-proxy" /usr/libexec/docker/docker-proxy /usr/lib/docker/docker-proxy; do
    if [ -x "$path" ]; then proxy=$path; break; fi
  done
fi
test -x "$proxy"
cp -L -- "$proxy" "$work/bin/docker-proxy"
for plugin in compose buildx; do
  source_path=$(docker info --format "{{range .ClientInfo.Plugins}}{{if eq .Name \"$plugin\"}}{{.Path}}{{end}}{{end}}")
  test -f "$source_path"
  cp -L -- "$source_path" "$work/plugins/docker-$plugin"
done
cp -L -- "$(command -v sshd)" "$work/host-ssh/sshd"
copy_ssh_libraries() {
  libraries=$(ldd "$1")
  if printf '%s\n' "$libraries" | grep -q 'not found'; then
    printf 'Missing SSH library for %s\n' "$1" >&2
    exit 2
  fi
  printf '%s\n' "$libraries" | awk '/=> \/.*\(/ {print $3}' | while IFS= read -r file; do
    case "$(basename "$file")" in
      libc.so.*|libpthread.so.*|libdl.so.*|libresolv.so.*|libutil.so.*|librt.so.*|libm.so.*) ;;
      *) cp -L -- "$file" "$work/host-ssh/" ;;
    esac
  done
}
copy_ssh_libraries "$work/host-ssh/sshd"
for helper_dir in /usr/lib/openssh /usr/libexec/openssh /usr/libexec; do
  for helper in sshd-session sshd-auth; do
    if [ -x "$helper_dir/$helper" ]; then
      mkdir -p "$work/host-ssh/helpers$helper_dir"
      cp -L -- "$helper_dir/$helper" "$work/host-ssh/helpers$helper_dir/$helper"
      copy_ssh_libraries "$helper_dir/$helper"
    fi
  done
done
ssh-keygen -q -t ed25519 -N '' -f "$work/host-ssh/fixture-admin"

create_network() {
  subnet=$1
  shift
  if [ -n "$subnet" ]; then set -- --subnet "$subnet" "$@"; fi
  docker network create --label "veyops.acceptance=$prefix" "$@" >/dev/null
}

create_network "${VEYOPS_ACCEPT_NETWORK_SUBNET:-}" --internal "$network"
for target in $targets; do
  mkdir -p "$work/targets/$target/deploy"
  ssh-keygen -q -t ed25519 -N '' -f "$work/host-ssh/$target"
  docker run --pull=never -d --privileged --cgroupns=host --name "$prefix-$target" \
    --network "$network" --network-alias "$target" --label "veyops.acceptance=$prefix" \
    --mount "type=bind,src=$work,dst=/accept" \
    --mount "type=bind,src=$work/targets/$target/deploy,dst=/srv/veyops-stage0" \
    --entrypoint /bin/sh "$target_image" /accept/tools/acceptance/target-start.sh "$target" >/dev/null
done

target_docker() {
  socket="$work/targets/$1/docker.sock"
  shift
  env -u DOCKER_CONTEXT -u DOCKER_HOST -u DOCKER_TLS_VERIFY docker --host "unix://$socket" "$@"
}
for target in $targets; do
  for attempt in $(seq 1 45); do
    if target_docker "$target" info >/dev/null 2>&1; then break; fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$prefix-$target")" != true ]; then break; fi
    sleep 1
  done
  if ! target_docker "$target" info >/dev/null 2>&1; then
    docker logs --tail 45 "$prefix-$target" >&2
    exit 1
  fi
done

# Save before loading so a failed save cannot be masked by a pipeline.
case "$mode" in
  flow-v2) ;;
  flow-v2-image) docker image save -o "$work/images.tar" "$site_image" ;;
  *) docker image save -o "$work/images.tar" "$site_image" "$target_image" ;;
esac
if [ "$mode" != flow-v2 ]; then
  for target in $targets; do
    target_docker "$target" image load -i "$work/images.tar" >"$work/targets/$target/image-load.log"
  done
  rm -f -- "$work/images.tar"
fi

if [ "$database" = postgres ]; then
  password=$(openssl rand -hex 24)
  {
    printf 'POSTGRES_DB=veyops_acceptance\nPOSTGRES_USER=veyops\n'
    printf 'POSTGRES_PASSWORD=%s\n' "$password"
  } >"$work/postgres.env"
  docker run --pull=never -d --name "$postgres" --network "$network" --network-alias database \
    --label "veyops.acceptance=$prefix" --env-file "$work/postgres.env" "$postgres_image" >/dev/null
  for attempt in $(seq 1 45); do
    if docker exec "$postgres" pg_isready -h 127.0.0.1 -U veyops -d veyops_acceptance >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec "$postgres" pg_isready -h 127.0.0.1 -U veyops -d veyops_acceptance >/dev/null
  docker exec "$postgres" createdb -U veyops veyops_restore
fi

{
  printf 'NODE_ENV=production\nHOST=0.0.0.0\nPORT=3000\nCOOKIE_SECURE=false\nWORKER_ENABLED=true\n'
  printf 'DATABASE_CLIENT=%s\nDATABASE_PATH=/accept/app/app.db\nDATA_DIR=/accept/app\n' "$database"
  if [ "$database" = postgres ]; then
    printf 'DATABASE_URL=postgresql://veyops:%s@database:5432/veyops_acceptance\n' "$password"
    printf 'VEYOPS_ACCEPT_RESTORE_DATABASE_URL=postgresql://veyops:%s@database:5432/veyops_restore\n' "$password"
  fi
  printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'DOCKER_HOST=unix:///accept/targets/test-a/docker.sock\nNODE_PATH=/app/apps/api/node_modules:/app/node_modules\n'
  printf 'BUILD_HELPER_IMAGE=%s\nVEYOPS_ACCEPT_BUILD_IMAGE=%s\n' "$target_image" "$target_image"
} >"$work/bootstrap.env"
{
  printf 'revision=%s\ndatabase=%s\n' "$revision" "$database"
  for image in "$candidate" "$target_image" "$site_image"; do
    printf '%s=%s\n' "$image" "$(docker image inspect --format '{{.Id}}' "$image")"
  done
  if [ "$database" = postgres ]; then
    printf '%s=%s\n' "$postgres_image" "$(docker image inspect --format '{{.Id}}' "$postgres_image")"
  fi
} >"$work/candidate.txt"

if [ "$mode" = preview ]; then
  create_network "${VEYOPS_ACCEPT_PREVIEW_SUBNET:-}" "$preview_network"
  set -- --network "$preview_network" --publish "$bind:3000"
else
  set -- --network "$network" --network-alias manager
fi
docker create --pull=never --name "$manager" --user root "$@" \
  --label "veyops.acceptance=$prefix" --env-file "$work/bootstrap.env" \
  --mount "type=bind,src=$work,dst=/accept" \
  --mount "type=bind,src=$work/plugins,dst=/usr/local/lib/docker/cli-plugins,readonly" \
  --entrypoint /bin/sh "$candidate" -eu -c 'export PATH=/accept/bin:$PATH; exec node /accept/tools/acceptance/p1-delivery.cjs "$@"' sh "$revision" "$site_image" "$mode" >/dev/null
if [ "$mode" = preview ]; then
  docker network connect --alias manager "$network" "$manager"
fi
docker start "$manager" >/dev/null
if [ "$mode" = preview ]; then
  for attempt in $(seq 1 90); do
    if [ -s "$work/preview.json" ] && curl -fsS --max-time 3 "http://$bind/api/v1/health" >/dev/null 2>&1; then
      rm -f -- "$work/bootstrap.env" "$work/postgres.env"
      trap - EXIT INT TERM
      printf 'Preview URL: http://%s\nPreview container: %s\nPreview workspace: %s\n' "$bind" "$manager" "$work"
      cat "$work/preview.json"
      exit 0
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$manager")" != true ]; then break; fi
    sleep 1
  done
  docker logs --tail 50 "$manager" >&2
  exit 1
fi
exit_code=$(docker wait "$manager")
docker logs "$manager" >"$work/manager.log" 2>&1
cat "$work/manager.log"
test "$exit_code" -eq 0
test -s "$work/evidence.json"
