#!/usr/bin/env bash
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

BRIDGE="${WECHAT_BRIDGE_HOME:-$HOME/workspace/agent2wechat}"
STATE_FILE="$HOME/hooks/state/wechat-inbox-announced.tsv"
mkdir -p "$HOME/hooks/state"
touch "$STATE_FILE"

now=$(date +%s)
tmp_state=$(mktemp)
wake_items="[]"
changed=0

# scan_dir <dir> <kind>
scan_dir() {
  local dir="$1" kind="$2"
  [ -d "$dir" ] || return 0
  local f base last
  for f in "$dir"/*.json; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    last=$(awk -v k="$kind/$base" '$1==k {print $2}' "$STATE_FILE" | tail -1)
    if [ -z "$last" ] || [ $((now - last)) -ge 600 ]; then
      local content
      content=$(jq -c '{id, from_user_id, text: (.text // "" | .[0:2000]), has_media: (.has_media // false), context_token: (.context_token // ""), kind: (.kind // "")}' "$f" 2>/dev/null || echo '{}')
      wake_items=$(jq -c --arg kind "$kind" --arg file "$base" --argjson item "$content" '. + [{kind: $kind, file: $file, message: $item}]' <<<"$wake_items")
      echo "$kind/$base $now" >> "$tmp_state"
      changed=1
    fi
  done
}

scan_dir "$BRIDGE/inbox" "inbox"
scan_dir "$BRIDGE/alerts" "alert"

# carry over still-valid announcements for files that still exist
while IFS=' ' read -r key ts; do
  [ -z "$key" ] && continue
  kind="${key%%/*}"; base="${key#*/}"
  if [ -e "$BRIDGE/$kind/$base" ] && ! grep -qxF "$key $now" "$tmp_state"; then
    # keep original timestamp unless just re-announced above
    if ! awk -v k="$key" '$1==k {found=1} END {exit !found}' "$tmp_state"; then
      echo "$key $ts" >> "$tmp_state"
    fi
  fi
done < "$STATE_FILE"

if [ "${HATCH_HOOK_DRY_RUN:-0}" != "1" ]; then
  mv "$tmp_state" "$STATE_FILE"
else
  rm -f "$tmp_state"
fi

count=$(jq 'length' <<<"$wake_items")
if [ "$count" -gt 0 ]; then
  log "agent2wechat wake" "$(jq -c '{count: length}' <<<"$wake_items")"
  wake "agent2wechat_events" "$(jq -c '{items: .}' <<<"$wake_items")"
else
  silent "no new wechat bridge events" '{}'
fi
