#!/usr/bin/env bash
# Forward-merge upstream + channel forks into PrimeAxisDevs/nanoclaw main
# Run weekly. Stops on first conflict so you can resolve and re-run.
set -euo pipefail

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

if [[ "$CHANGED" -eq 1 ]]; then
  echo "── rebuilding"
  npm install
  npm run build 2>/dev/null || pnpm build || echo "build step skipped"
  
  echo "── pushing to origin"
  git push origin main
  
  echo "── restarting nanoclaw"
  sudo systemctl restart nanoclaw.service
fi

echo "✅ sync complete"
