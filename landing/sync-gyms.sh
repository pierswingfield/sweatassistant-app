#!/usr/bin/env bash
# Refresh landing/gyms from the app's own logos (client/public/gyms), the single source of truth.
# Run by deploy-landing.sh; run it by hand before opening landing/index.html locally.
# landing/gyms is git-ignored: never edit it, edit client/public/gyms.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf landing/gyms
mkdir -p landing/gyms
cp -R client/public/gyms/. landing/gyms/
echo "landing/gyms <- client/public/gyms ($(ls landing/gyms | wc -l | tr -d ' ') files)"
