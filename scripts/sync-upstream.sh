#!/usr/bin/env bash
# Forward-merge upstream + channel forks into PrimeAxisDevs/nanoclaw main
# Runs every 2 weeks via the nanoclaw-sync.timer systemd unit.
# Stops on first conflict, and aborts before push/restart if the build fails.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$(hostname)"

# Send a notification to the NanoClaw main chat. Never fail the sync over it.
notify() {
  node "$SCRIPT_DIR/notify.mjs" "$1" || echo "⚠️  could not send notification"
}

# Notify on any non-zero exit, mapping the known exit codes to a clear reason.
on_exit() {
  local code=$?
  case "$code" in
    0) ;;
    1) notify "🔴 NanoClaw sync aborted on ${HOST}: working tree was dirty. Commit/stash and re-run." ;;
    2) notify "🔴 NanoClaw sync aborted on ${HOST}: merge conflict from upstream. Resolve and re-run. (journalctl --user -u nanoclaw-sync)" ;;
    3) notify "🔴 NanoClaw sync aborted on ${HOST}: build FAILED — not pushed or restarted, old version still running. (journalctl --user -u nanoclaw-sync)" ;;
    *) notify "🔴 NanoClaw sync failed on ${HOST} (exit ${code}). Check journalctl --user -u nanoclaw-sync" ;;
  esac
}
trap on_exit EXIT

cd /home/ares/nanoclaw

# Bail if dirty
if ! git diff-index --quiet HEAD --; then
  echo "❌ Working tree dirty — commit/stash first."
  git status -sb
  exit 1
fi

git checkout main
git pull origin main

REMOTES=(upstream whatsapp telegram slack discord gmail)
CHANGED=0

for remote in "${REMOTES[@]}"; do
  echo "── fetching $remote"
  git fetch "$remote"
  
  BEFORE=$(git rev-parse HEAD)
  if git merge --no-edit "$remote/main" 2>&1; then
    AFTER=$(git rev-parse HEAD)
    if [[ "$BEFORE" != "$AFTER" ]]; then
      echo "✅ merged $remote/main"
      CHANGED=1
    else
      echo "── $remote/main already up to date"
    fi
  else
    echo "⚠️  conflict merging $remote/main — resolve and re-run"
    exit 2
  fi
done

# Also deploy if we have commits not yet on origin — e.g. a previous run
# merged successfully but aborted on a failed build before pushing. This lets
# a transient build failure recover on the next scheduled run.
if [[ "$(git rev-list --count origin/main..HEAD)" -gt 0 ]]; then
  CHANGED=1
fi

if [[ "$CHANGED" -eq 1 ]]; then
  echo "── rebuilding"
  npm install
  if ! npm run build; then
    echo "❌ build failed — not pushing or restarting. Resolve and re-run."
    exit 3
  fi

  echo "── pushing to origin"
  git push origin main
  
  echo "── restarting nanoclaw"
  sudo systemctl restart nanoclaw.service

  notify "🟢 NanoClaw sync on ${HOST}: merged upstream changes, build passed, pushed to origin, and restarted."
else
  notify "🟢 NanoClaw sync on ${HOST}: already up to date — no changes."
fi

echo "✅ sync complete"
