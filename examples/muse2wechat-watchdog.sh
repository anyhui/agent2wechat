#!/usr/bin/env bash
set -uo pipefail
source "$HATCH_HOOK_RUNTIME"

UNIT=/etc/systemd/system/muse2wechat.service

if [ -f "$UNIT" ] && systemctl is-active --quiet muse2wechat; then
  silent "muse2wechat healthy" '{}'
  exit 0
fi

# Repair: reinstall from the workspace (install script reuses the persisted
# proxy env, so this works without an interactive shell).
cd "${WECHAT_BRIDGE_HOME:-$HOME/workspace/muse2wechat}" 2>/dev/null || {
  wake "muse2wechat_watchdog" '{"result":"repair_failed","reason":"workdir_missing"}'
  exit 0
}
if bash install-service.sh >/dev/null 2>&1 && systemctl is-active --quiet muse2wechat; then
  wake "muse2wechat_watchdog" '{"result":"repaired"}'
else
  wake "muse2wechat_watchdog" '{"result":"repair_failed"}'
fi
