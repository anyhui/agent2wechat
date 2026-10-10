#!/usr/bin/env bash
# Installs the muse2wechat systemd unit.
# The unit needs this VM's egress-proxy environment for Node fetch to reach
# ilinkai.weixin.qq.com, so the proxy vars are copied from the *current*
# shell environment at install time instead of being stored in the repo.
set -euo pipefail

UNIT=/etc/systemd/system/muse2wechat.service
WORKDIR="$(cd "$(dirname "$0")" && pwd)"
ENVFILE="$WORKDIR/proxy-env.sh"

# Unattended reinstalls (watchdog) have no interactive shell env: reuse the
# proxy vars captured by the last install.
if [ -f "$ENVFILE" ]; then
  # shellcheck disable=SC1090
  . "$ENVFILE"
fi

{
  echo "[Unit]"
  echo "Description=muse2wechat bridge (iLink)"
  echo "After=network-online.target"
  echo "Wants=network-online.target"
  echo ""
  echo "[Service]"
  echo "Type=simple"
  for v in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY; do
    if [ -n "${!v:-}" ]; then
      echo "Environment=$v=${!v}"
    fi
  done
  echo "Environment=NODE_USE_ENV_PROXY=1"
  echo "ExecStart=/usr/bin/node $WORKDIR/bridge.mjs run"
  echo "WorkingDirectory=$WORKDIR"
  echo "Restart=always"
  echo "RestartSec=5"
  echo ""
  echo "[Install]"
  echo "WantedBy=multi-user.target"
} > "$UNIT"
chmod 600 "$UNIT"

# Persist the effective proxy vars for unattended reinstalls.
{
  for v in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY; do
    if [ -n "${!v:-}" ]; then
      printf 'export %s=%q\n' "$v" "${!v}"
    fi
  done
} > "$ENVFILE"
chmod 600 "$ENVFILE"

systemctl daemon-reload
systemctl enable --now muse2wechat.service
systemctl restart muse2wechat.service
echo "muse2wechat installed and (re)started."
