#!/bin/sh
set -eu

# Run on the Linux Docker host from a fresh acceptance directory.
# The acceptance daemon and SSH service share this directory and have no host Docker socket.
work=$(pwd -P)
case "$work" in
  /tmp/veyops-p1-*) ;;
  *) printf '%s\n' 'Run inside a dedicated /tmp/veyops-p1-* directory.' >&2; exit 2 ;;
esac
suffix=$(basename "$work" | sed 's/^veyops-p1-//')
case "$suffix" in
  ''|*[!a-zA-Z0-9]*) exit 2 ;;
esac
engine="veyops-p1-engine-$suffix"
network="veyops-p1-net-$suffix"
base=${VEYOPS_ACCEPT_RUNTIME_IMAGE:-veyops:1.0.0}
engine_base=${VEYOPS_ACCEPT_ENGINE_IMAGE:-node:24-slim}
site_base=${VEYOPS_ACCEPT_SITE_IMAGE:-busybox:latest}
manager="veyops-p1-api-$suffix"
production="veyops-p1-prod-$suffix"
revision=${1:?Pass the candidate Git revision}
case "$revision" in
  *[!a-f0-9]*) exit 2 ;;
esac
test "${#revision}" -eq 40

cleanup() {
  for name in "$manager" "$production" "$engine"; do
    if [ "$(docker inspect --format '{{index .Config.Labels "veyops.acceptance"}}' "$name" 2>/dev/null || :)" = "$suffix" ]; then
      docker rm -fv "$name" >/dev/null
    fi
  done
  if [ "$(docker network inspect --format '{{index .Labels "veyops.acceptance"}}' "$network" 2>/dev/null || :)" = "$suffix" ]; then
    docker network rm "$network" >/dev/null
  fi
  rm -f -- "$work/bootstrap.env"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for image in "$base" "$engine_base" "$site_base"; do
  docker image inspect "$image" >/dev/null
done
mkdir -p bin plugins host-ssh target app repo
for tool in dockerd docker containerd containerd-shim-runc-v2 runc; do
  source_path=$(command -v "$tool")
  cp -L -- "$source_path" "bin/$tool"
done
for plugin in compose buildx; do
  source_path=$(docker info --format "{{range .ClientInfo.Plugins}}{{if eq .Name \"$plugin\"}}{{.Path}}{{end}}{{end}}")
  test -f "$source_path"
  cp -L -- "$source_path" "plugins/docker-$plugin"
done
cp -L -- "$(command -v sshd)" host-ssh/sshd
ldd host-ssh/sshd | awk '/=> \/.*\(/ {print $3}' | while IFS= read -r file; do
  case "$(basename "$file")" in
    libc.so.*|libpthread.so.*|libdl.so.*|libm.so.*|libresolv.so.*|libutil.so.*|librt.so.*) ;;
    *) cp -L -- "$file" host-ssh/ ;;
  esac
done
ssh-keygen -q -t ed25519 -N '' -f "$work/host-ssh/fixture-host"
ssh-keygen -q -t ed25519 -N '' -f "$work/host-ssh/fixture-prod"
ssh-keygen -q -t ed25519 -N '' -f "$work/host-ssh/fixture-admin"
chmod 600 "$work/host-ssh/fixture-host" "$work/host-ssh/fixture-prod" "$work/host-ssh/fixture-admin"

cat >engine-start.sh <<'SH'
#!/bin/sh
set -eu
export PATH=/accept/bin:$PATH
mode=${1:-engine}
if [ "$mode" = engine ]; then
parent=$(sed -n 's/^0:://p' /proc/self/cgroup | head -n 1)
case "$parent" in
  /docker/*|*/docker-*.scope) ;;
  *) printf '%s\n' 'Cannot identify the acceptance container cgroup.' >&2; exit 2 ;;
esac
# Keep the private daemon's supervisor and its resource-limited builds in sibling cgroups.
group="/sys/fs/cgroup$parent"
mkdir "$group/acceptance-supervisor"
printf '%s\n' "$$" >"$group/acceptance-supervisor/cgroup.procs"
for controller in cpu memory pids; do
  printf '+%s\n' "$controller" >"$group/cgroup.subtree_control"
done
fi
mkdir -p /run/sshd /root/.ssh /usr/local/lib/docker /accept/target
chmod 700 /root/.ssh
cp /accept/host-ssh/fixture-admin.pub /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
if ! id sshd >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin sshd
fi
passwd -d root >/dev/null
ln -s /accept/plugins /usr/local/lib/docker/cli-plugins
ln -s /accept/docker.sock /var/run/docker.sock
ln -s /accept/bin/docker /usr/local/bin/docker
key=fixture-host
if [ "$mode" = ssh ]; then key=fixture-prod; fi
cat >/etc/ssh-acceptance <<CONFIG
Port 22
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
UsePAM no
HostKey /accept/host-ssh/$key
Subsystem sftp internal-sftp
CONFIG
# Keep dependencies for the host sshd in a separate search path.
if [ "$mode" = ssh ]; then
  LD_LIBRARY_PATH=/accept/host-ssh exec /accept/host-ssh/sshd -D -f /etc/ssh-acceptance
fi
LD_LIBRARY_PATH=/accept/host-ssh /accept/host-ssh/sshd -f /etc/ssh-acceptance
node -e 'const {createServer}=require("node:http"); const {readFile}=require("node:fs"); createServer((_,res)=>readFile("/srv/veyops-acceptance/test/current/index.html",(error,body)=>{res.statusCode=error?503:200;res.end(error?"not ready":body)})).listen(18080,"0.0.0.0");' &
rm -f -- /accept/docker.sock
exec dockerd --host=unix:///accept/docker.sock --storage-driver=vfs --iptables=false --ip6tables=false --userland-proxy=false \
  --cgroup-parent="$parent" --exec-opt native.cgroupdriver=cgroupfs \
  --data-root=/accept/engine-data --exec-root=/run/veyops-p1 --pidfile=/run/veyops-p1.pid
SH
docker network create --internal --label "veyops.acceptance=$suffix" "$network" >/dev/null
docker run --pull=never -d --privileged --cgroupns=host --name "$engine" --network "$network" --network-alias target \
  --label "veyops.acceptance=$suffix" --mount "type=bind,src=$work,dst=/accept" --entrypoint /bin/sh \
  --mount "type=bind,src=$work/target,dst=/srv/veyops-acceptance" \
  "$engine_base" /accept/engine-start.sh >/dev/null
engine_docker() {
  docker --host "unix://$work/docker.sock" "$@"
}
for attempt in $(seq 1 45); do
  if engine_docker info >/dev/null 2>&1; then break; fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$engine")" != true ]; then break; fi
  sleep 1
done
if ! engine_docker info >/dev/null 2>&1; then
  docker logs --tail 35 "$engine" >&2
  exit 1
fi
docker image save "$site_base" | engine_docker image load >image-load.log
if [ "$engine_base" != "$site_base" ]; then
  docker image save "$engine_base" | engine_docker image load >>image-load.log
fi
engine_docker run --pull=never --rm --cpus 2 --memory 1g --pids-limit 128 "$site_base" sh -c 'printf engine-ready'
printf '\n'
if [ "${VEYOPS_ACCEPT_ENGINE_ONLY:-}" = 1 ]; then exit 0; fi
docker run --pull=never -d --name "$production" --network "$network" --network-alias target-prod \
  --label "veyops.acceptance=$suffix" --mount "type=bind,src=$work,dst=/accept" --entrypoint /bin/sh \
  --mount "type=bind,src=$work/target,dst=/srv/veyops-acceptance" \
  "$engine_base" /accept/engine-start.sh ssh >/dev/null

umask 077
{
  printf 'NODE_ENV=production\nHOST=0.0.0.0\nPORT=3000\n'
  printf 'DATABASE_CLIENT=sqlite\nDATABASE_PATH=/accept/app/app.db\nDATA_DIR=/accept/app\nWORKER_ENABLED=true\n'
  printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'DOCKER_HOST=unix:///accept/docker.sock\n'
  printf 'BUILD_HELPER_IMAGE=%s\n' "$engine_base"
} >bootstrap.env
test -f dist/apps/api/dist/bootstrap.js
test -f dist/apps/web/dist/index.html
docker run --pull=never -d --name "$manager" --user root --network "$network" --network-alias manager \
  --label "veyops.acceptance=$suffix" --env-file bootstrap.env --mount "type=bind,src=$work,dst=/accept" \
  --mount "type=bind,src=$work/target,dst=/srv/veyops-acceptance" \
  --mount "type=bind,src=$work/plugins,dst=/usr/local/lib/docker/cli-plugins,readonly" \
  --mount "type=bind,src=$work/dist/apps/api/dist,dst=/app/apps/api/dist,readonly" \
  --mount "type=bind,src=$work/dist/apps/web/dist,dst=/app/apps/web/dist,readonly" \
  --entrypoint /bin/sh "$base" -eu -c 'export PATH=/accept/bin:$PATH; exec node /accept/p1-delivery.cjs "$@"' sh "$revision" "$site_base" >/dev/null
exit_code=$(docker wait "$manager")
docker logs "$manager"
test "$exit_code" -eq 0
