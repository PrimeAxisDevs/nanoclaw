#!/usr/bin/env bash
# Forward-merge upstream + channel forks into PrimeAxisDevs/nanoclaw main.
#
# ┌─ SAFETY (hardened 2026-06-13, after the 2026-06-01 incident) ──────────────┐
# │ The previous version ran `git merge` and on conflict did `exit 2` WITHOUT  │
# │ aborting — leaving a half-merged tree with conflict markers. That broke    │
# │ the container image build and crash-looped the live agent for 11 days.     │
# │                                                                            │
# │ This version GUARANTEES:                                                   │
# │   - On ANY merge conflict: `git merge --abort` + hard reset to the         │
# │     pre-sync commit. The tree is NEVER left half-merged.                   │
# │   - It NEVER pushes a conflicted or unbuilt state.                         │
# │   - On conflict / build / push failure it sends a Telegram alert and stops.│
# │                                                                            │
# │ MANUAL-RUN ONLY. The systemd timer (nanoclaw-sync.timer) is DISABLED.      │
# │ Do NOT re-enable it until the v2 upstream divergence (~1000+ commits) has  │
# │ a real migration plan — a conflicting auto-merge will just alert + abort,  │
# │ but you still want to drive that migration by hand.                        │
# │     Run manually:  bash scripts/sync-upstream.sh                           │
# └────────────────────────────────────────────────────────────────────────────┘
#
# NOTE: intentionally NOT using `set -e` — every failure is handled explicitly
# so we can always abort the merge and alert before exiting.
set -uo pipefail

cd /home/ares/nanoclaw || { echo "cannot cd to repo"; exit 1; }

# --- Telegram alert target ----------------------------------------------------
# Read from .env unless already set in the environment.
read_env() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "\"' " ; }
: "${TELEGRAM_BOT_TOKEN:=$(read_env TELEGRAM_BOT_TOKEN)}"
# Default alert chat = James's main Telegram command-centre (tg:5402601822,
# is_main). Override by adding SYNC_ALERT_CHAT_ID=<chat_id> to .env.
: "${SYNC_ALERT_CHAT_ID:=$(read_env SYNC_ALERT_CHAT_ID)}"
: "${SYNC_ALERT_CHAT_ID:=5402601822}"

alert() {
  local text="$1"
  echo "ALERT: $text"
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${SYNC_ALERT_CHAT_ID:-}" ]]; then
    if curl -s --max-time 15 -o /dev/null \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${SYNC_ALERT_CHAT_ID}" \
        --data-urlencode "text=[NanoClaw sync] ${text}"; then
      echo "(telegram alert sent to ${SYNC_ALERT_CHAT_ID})"
    else
      echo "(telegram alert FAILED to send)"
    fi
  else
    echo "(TELEGRAM_BOT_TOKEN / SYNC_ALERT_CHAT_ID unset — telegram alert skipped)"
  fi
}

# --- preconditions ------------------------------------------------------------
if ! git diff-index --quiet HEAD --; then
  alert "Working tree dirty — sync aborted before any merge. Commit/stash first."
  git status -sb
  exit 1
fi
if [[ -e .git/MERGE_HEAD ]]; then
  alert "A merge is already in progress (.git/MERGE_HEAD present) — sync NOT started. Resolve or abort it manually."
  exit 1
fi

git checkout main || { alert "git checkout main failed — sync aborted."; exit 1; }
if ! git pull --ff-only origin main; then
  alert "git pull --ff-only origin main failed (origin/main diverged?) — sync aborted, nothing merged."
  exit 1
fi

# Snapshot the known-good starting point for all-or-nothing rollback.
START=$(git rev-parse HEAD)

# fail <exit-code> <message>: abort any in-progress merge, roll back to START
# (so no conflict markers and no partial merge commits survive), alert, exit.
fail() {
  local code="$1"; shift
  git merge --abort 2>/dev/null || true
  git reset --hard "$START" >/dev/null 2>&1 || true
  alert "$*"
  exit "$code"
}

REMOTES=(upstream whatsapp telegram slack discord gmail)
CHANGED=0

for remote in "${REMOTES[@]}"; do
  echo "── $remote"
  if ! git remote get-url "$remote" >/dev/null 2>&1; then
    echo "   remote '$remote' not configured — skipping"
    continue
  fi
  if ! git fetch "$remote"; then
    # A fetch failure is not a half-merge risk — warn and skip this remote.
    alert "git fetch $remote failed — skipped (no merge attempted for it)."
    continue
  fi

  # --no-commit + --no-ff: stage the merge so we can inspect it and bail
  # cleanly on conflict before anything is committed.
  if git merge --no-commit --no-ff "$remote/main"; then
    if git diff --cached --quiet; then
      echo "   $remote/main already up to date"
      git merge --abort 2>/dev/null || true   # clear any no-op merge state
    else
      if git commit --no-edit; then
        echo "   merged $remote/main"
        CHANGED=1
      else
        fail 2 "commit after merging $remote/main failed — aborted and rolled back to ${START:0:8}, nothing pushed."
      fi
    fi
  else
    fail 2 "CONFLICT merging $remote/main — merge ABORTED and rolled back to ${START:0:8}. Nothing pushed, tree clean. Manual resolution required (likely the v2 divergence). Sync stopped."
  fi
done

if [[ "$CHANGED" -eq 1 ]]; then
  echo "── rebuilding"
  # On build/push failure: do NOT roll back (the tree is clean + committed,
  # just unpushed) so the merge work can be inspected. But NEVER push it.
  if ! npm install; then
    alert "npm install failed after merges — NOT pushing, NOT restarting. Local merge commits are unpushed; review then push manually or 'git reset --hard origin/main'."
    exit 3
  fi
  if ! npm run build; then
    alert "npm run build failed after merges — NOT pushing, NOT restarting. Local merge commits are unpushed; review then push manually or 'git reset --hard origin/main'."
    exit 3
  fi

  echo "── pushing to origin"
  if ! git push origin main; then
    alert "git push origin main failed — built OK locally but push failed. Review/retry push."
    exit 3
  fi

  echo "── restarting nanoclaw (user service)"
  if ! systemctl --user restart nanoclaw.service; then
    alert "Sync merged+built+pushed, but nanoclaw restart FAILED — check 'systemctl --user status nanoclaw'."
    exit 3
  fi
  alert "Sync OK — merged, built, pushed, and nanoclaw restarted."
else
  echo "sync complete — nothing new to merge"
fi
