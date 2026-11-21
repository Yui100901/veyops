#!/bin/sh
set -eu

target=${1:?Missing acceptance target alias}
case "$target" in test-a|test-b|production-a|production-b) ;; *) exit 2 ;; esac
state="/accept/targets/$target"
export PATH=/accept/bin:$PATH

# Private Docker builds and their supervisor stay below this target container's
# own cgroup. Never enable controllers in the host root or sibling cgroups.
parent=$(sed -n 's/^0:://p' /proc/self/cgroup | head -n 1)
case "$parent" in
  /docker/*|*/docker-*.scope) ;;
  *) printf '%s\n' 'Cannot identify the acceptance target cgroup.' >&2; exit 2 ;;
esac
group="/sys/fs/cgroup$parent"
mkdir "$group/acceptance-supervisor"
printf '%s\n' "$$" >"$group/acceptance-supervisor/cgroup.procs"
for controller in cpu memory pids; do
  printf '+%s\n' "$controller" >"$group/cgroup.subtree_control"
done

mkdir -p /run/sshd /root/.ssh /usr/local/lib/docker
chmod 700 /root/.ssh
cp /accept/host-ssh/fixture-admin.pub /root/.ssh/authorized_keys
cp "/accept/host-ssh/$target" /etc/veyops-acceptance-host-key
chmod 600 /root/.ssh/authorized_keys /etc/veyops-acceptance-host-key
if ! id sshd >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin sshd
fi
passwd -d root >/dev/null
for helper_dir in /usr/lib/openssh /usr/libexec/openssh /usr/libexec; do
  for helper in sshd-session sshd-auth; do
    if [ -f "/accept/host-ssh/helpers$helper_dir/$helper" ]; then
      mkdir -p "$helper_dir"
      cp -- "/accept/host-ssh/helpers$helper_dir/$helper" "$helper_dir/$helper"
    fi
  done
done
ln -s /accept/plugins /usr/local/lib/docker/cli-plugins
ln -s "$state/docker.sock" /var/run/docker.sock
cat >/etc/ssh-veyops-acceptance <<'CONFIG'
Port 22
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
HostKey /etc/veyops-acceptance-host-key
Subsystem sftp internal-sftp
CONFIG
LD_LIBRARY_PATH=/accept/host-ssh /accept/host-ssh/sshd -f /etc/ssh-veyops-acceptance

# Exercise the real current symlink through the target network.
node -e '
  const {createServer} = require("node:http");
  const {readFile} = require("node:fs");
  createServer((request, response) => {
    if (request.url !== "/") { response.writeHead(404).end(); return; }
    readFile("/srv/veyops-stage0/storefront/current/index.html", (error, body) => {
      response.statusCode = error ? 503 : 200;
      response.end(error ? "not ready" : body);
    });
  }).listen(18080, "0.0.0.0");' &

exec dockerd --host="unix://$state/docker.sock" --storage-driver=vfs \
  --iptables=false --ip6tables=false --userland-proxy=true --userland-proxy-path=/accept/bin/docker-proxy \
  --cgroup-parent="$parent" --exec-opt native.cgroupdriver=cgroupfs \
  --data-root="$state/engine" --exec-root=/run/veyops-acceptance --pidfile=/run/veyops-acceptance.pid
