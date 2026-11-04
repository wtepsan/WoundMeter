#!/bin/sh
set -eu
umask 027
(cd /app/models && sha256sum -c SHA256SUMS)
for sub in '' private_storage image_input image_crop image_result; do
  mkdir -p "/app/data/$sub"
  chown woundmeter:woundmeter "/app/data/$sub"
  chmod 0750 "/app/data/$sub"
done
# /demo photo folder (bind-mounted from the host): writable by the API, group-owned by the host
# folder's group (setgid) so the host account can read and remove the photos without root.
if [ -d /app/demo-data ]; then
  host_gid=$(stat -c %g /app/demo-data)
  # The API user joins the host folder's group so new photos inherit it (setgid) and stay group-writable.
  getent group "$host_gid" >/dev/null || groupadd -g "$host_gid" demohost
  usermod -aG "$(getent group "$host_gid" | cut -d: -f1)" woundmeter
  mkdir -p /app/demo-data/images
  chown "woundmeter:$host_gid" /app/demo-data/images
  chmod 2775 /app/demo-data/images
fi
gosu woundmeter python -m app.migrate
gosu woundmeter python -m app.bootstrap
exec gosu woundmeter "$@"
