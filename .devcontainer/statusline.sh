#!/bin/bash
# Claudeの最下部のステータスバーをリッチにするための設定集

# 各種場所
CLAUDE_DIR="$HOME/.claude"
USAGE_LOG="$CLAUDE_DIR/.sl_usage_log.csv"
LIVE_DIR="$CLAUDE_DIR/.sl_live"
QUOTA_FILE="$CLAUDE_DIR/.sl_quota_start"
QUOTA_WINDOW=18000  # 5 hours in seconds
mkdir -p "$LIVE_DIR"

input=$(cat)

# 各種情報を取得
model=$(echo "$input" | jq -r '.model.display_name // "unknown"')
input_tokens=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
output_tokens=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
context_size=$(echo "$input" | jq -r '.context_window.context_window_size // 200000')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // "0"')
session_id=$(echo "$input" | jq -r '.session_id // "unknown"')

# 各種計算
used_tokens=$((input_tokens + output_tokens))
current_used=$(awk "BEGIN {printf \"%.0f\", ($used_pct * $context_size) / 100}")
remaining_tokens=$((context_size - current_used))
[ "$remaining_tokens" -lt 0 ] && remaining_tokens=0
current_time=$(date +%s)

# Git branch
git_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "-")

# Format number with k/M suffix
fmt() {
  local n=$1
  if [ "$n" -ge 1000000 ] 2>/dev/null; then
    awk "BEGIN {printf \"%.1fM\", $n/1000000}"
  elif [ "$n" -ge 1000 ] 2>/dev/null; then
    awk "BEGIN {printf \"%.1fk\", $n/1000}"
  else
    echo "${n:-0}"
  fi
}

# Initialize usage log
[ ! -f "$USAGE_LOG" ] && echo "ts,sid,tokens" >"$USAGE_LOG"

# Per-session live state file
LIVE_FILE="$LIVE_DIR/${session_id}.json"

# Session tracking
burn_rate_str="--"
eta_str="--"
br_val=0
turn_count=1
compress_count=0

if [ -f "$LIVE_FILE" ]; then
  # Existing session: read previous state
  last_ctx=$(jq -r '.ctx // 0' "$LIVE_FILE" 2>/dev/null)
  last_turns=$(jq -r '.turns // 0' "$LIVE_FILE" 2>/dev/null)
  s_start=$(jq -r '.start // 0' "$LIVE_FILE" 2>/dev/null)
  compress_count=$(jq -r '.compress // 0' "$LIVE_FILE" 2>/dev/null)
  compress_last=$(jq -r '.compress_last // 0' "$LIVE_FILE" 2>/dev/null)

  # Turn count: increment if context usage changed
  if [ "$current_used" -ne "${last_ctx:-0}" ]; then
    turn_count=$((last_turns + 1))
  else
    turn_count=$last_turns
  fi

  # Detect context compression (large drop in context usage)
  if [ "${compress_last:-0}" -gt 0 ] && [ "$current_used" -gt 0 ]; then
    drop=$((compress_last - current_used))
    threshold=$((compress_last / 5))
    if [ "$drop" -gt "$threshold" ] && [ "$drop" -gt 10000 ]; then
      compress_count=$((compress_count + 1))
    fi
  fi
else
  # New session
  s_start=$current_time
fi

# Write per-session live state
printf '{"tok":%d,"ctx":%d,"ts":%d,"turns":%d,"start":%d,"compress":%d,"compress_last":%d}' \
  "$used_tokens" "$current_used" "$current_time" "$turn_count" "$s_start" \
  "$compress_count" "$current_used" >"$LIVE_FILE"

# Calculate burn rate & ETA
pct_int=$(awk "BEGIN {printf \"%.0f\", ${used_pct:-0}}" 2>/dev/null || echo "0")
elapsed=$((current_time - s_start))
if [ "$elapsed" -gt 10 ] && [ "$pct_int" -gt 0 ]; then
  # Burn rate: percentage points per minute
  pct_per_min=$(awk "BEGIN {printf \"%.2f\", ($used_pct * 60.0) / $elapsed}")
  br_val=$(awk "BEGIN {printf \"%.0f\", ($current_used * 60.0) / $elapsed}")
  burn_rate_str="$(fmt "$br_val")/min"

  # ETA: remaining percentage / rate of percentage consumption
  remaining_pct=$(awk "BEGIN {printf \"%.2f\", 100.0 - $used_pct}")
  if [ "$(awk "BEGIN {print ($pct_per_min > 0)}")" = "1" ]; then
    eta_sec=$(awk "BEGIN {printf \"%.0f\", ($remaining_pct / $pct_per_min) * 60}")
    if [ "$eta_sec" -ge 3600 ] 2>/dev/null; then
      eta_str="$(awk "BEGIN {printf \"%.1f\", $eta_sec/3600}")h"
    elif [ "$eta_sec" -ge 60 ] 2>/dev/null; then
      eta_str="$(awk "BEGIN {printf \"%.0f\", $eta_sec/60}")min"
    else
      eta_str="${eta_sec}s"
    fi
  fi
fi

# Quota reset tracking (5-hour rolling window)
quota_reset_str="--"
if [ -f "$QUOTA_FILE" ]; then
  quota_start=$(cat "$QUOTA_FILE" 2>/dev/null)
  quota_elapsed=$((current_time - quota_start))
  if [ "$quota_elapsed" -ge "$QUOTA_WINDOW" ]; then
    # Window expired, start new one
    echo "$current_time" >"$QUOTA_FILE"
    quota_remaining=$QUOTA_WINDOW
  else
    quota_remaining=$((QUOTA_WINDOW - quota_elapsed))
  fi
else
  # First run, start window now
  echo "$current_time" >"$QUOTA_FILE"
  quota_remaining=$QUOTA_WINDOW
fi

# Format quota remaining time
q_h=$((quota_remaining / 3600))
q_m=$(( (quota_remaining % 3600) / 60 ))
if [ "$q_h" -gt 0 ]; then
  quota_reset_str="${q_h}h${q_m}m"
else
  quota_reset_str="${q_m}m"
fi

# Aggregate daily/weekly/monthly
day_start=$(date -j -v0H -v0M -v0S +%s 2>/dev/null || echo $((current_time - 86400)))
week_ago=$((current_time - 604800))
month_ago=$((current_time - 2592000))

d_total=0
w_total=0
m_total=0

# From historical CSV log
if [ -f "$USAGE_LOG" ]; then
  while IFS=, read -r ts sid tok; do
    [ "$ts" = "ts" ] && continue
    [[ "$tok" =~ ^[0-9]+$ ]] || continue
    [ "${ts:-0}" -ge "$day_start" ] 2>/dev/null && d_total=$((d_total + tok))
    [ "${ts:-0}" -ge "$week_ago" ] 2>/dev/null && w_total=$((w_total + tok))
    [ "${ts:-0}" -ge "$month_ago" ] 2>/dev/null && m_total=$((m_total + tok))
  done <"$USAGE_LOG"
fi

# From all active sessions (including other concurrent sessions)
for lf in "$LIVE_DIR"/*.json; do
  [ -f "$lf" ] || continue
  live_tok=$(jq -r '.tok // 0' "$lf" 2>/dev/null)
  live_ts=$(jq -r '.ts // 0' "$lf" 2>/dev/null)
  [ "${live_ts:-0}" -ge "$day_start" ] 2>/dev/null && d_total=$((d_total + live_tok))
  [ "${live_ts:-0}" -ge "$week_ago" ] 2>/dev/null && w_total=$((w_total + live_tok))
  [ "${live_ts:-0}" -ge "$month_ago" ] 2>/dev/null && m_total=$((m_total + live_tok))
done

# Periodic cleanup
if [ $((RANDOM % 50)) -eq 0 ]; then
  # Prune CSV entries older than 90 days
  if [ -f "$USAGE_LOG" ]; then
    cutoff=$((current_time - 7776000))
    tmp="$USAGE_LOG.tmp"
    head -1 "$USAGE_LOG" >"$tmp"
    tail -n +2 "$USAGE_LOG" | awk -F, -v c="$cutoff" '$1 >= c' >>"$tmp"
    mv "$tmp" "$USAGE_LOG"
  fi

  # Flush stale live files (older than 48h) to CSV and remove
  stale_cutoff=$((current_time - 172800))
  for lf in "$LIVE_DIR"/*.json; do
    [ -f "$lf" ] || continue
    [ "$lf" = "$LIVE_FILE" ] && continue
    live_ts=$(jq -r '.ts // 0' "$lf" 2>/dev/null)
    if [ "${live_ts:-0}" -lt "$stale_cutoff" ] 2>/dev/null; then
      stale_tok=$(jq -r '.tok // 0' "$lf" 2>/dev/null)
      stale_sid=$(basename "$lf" .json)
      [ "$stale_tok" -gt 0 ] 2>/dev/null && echo "$live_ts,$stale_sid,$stale_tok" >>"$USAGE_LOG"
      rm -f "$lf"
    fi
  done

  # Remove old global state files (migration cleanup)
  rm -f "$CLAUDE_DIR/.sl_session.json" "$CLAUDE_DIR/.sl_last_state.json" "$CLAUDE_DIR/.sl_compress.json" 2>/dev/null
fi

# Build progress bar
filled=$((pct_int / 10))
[ "$filled" -gt 10 ] && filled=10
empty=$((10 - filled))
bar=""
for ((i = 0; i < filled; i++)); do bar+="█"; done
for ((i = 0; i < empty; i++)); do bar+="░"; done

# Performance zone indicator
if [ "$pct_int" -ge 90 ]; then
  perf="🔴 Critical"
elif [ "$pct_int" -ge 70 ]; then
  perf="🟠 Warning"
elif [ "$pct_int" -ge 50 ]; then
  perf="🟡 Caution"
else
  perf="🟢 Good"
fi

# Output (3 lines)
printf "🤖 %s | 📝%d 🗜%s 📊 %s/%s %s %d%% %s │ ⏳~%s 🔥 %s │ ↓%s ↑%s │ 🔄%s\n🔀 %s │ Day:%s Week:%s Mo:%s" \
  "$model" \
  "$turn_count" \
  "$compress_count" \
  "$(fmt $current_used)" \
  "$(fmt $context_size)" \
  "$bar" \
  "$pct_int" \
  "$perf" \
  "$eta_str" \
  "$burn_rate_str" \
  "$(fmt $input_tokens)" \
  "$(fmt $output_tokens)" \
  "$quota_reset_str" \
  "$git_branch" \
  "$(fmt $d_total)" \
  "$(fmt $w_total)" \
  "$(fmt $m_total)"