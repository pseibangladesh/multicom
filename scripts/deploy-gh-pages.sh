#!/usr/bin/env bash
# Build the client SPA and publish it to the `gh-pages` branch for GitHub Pages
# (https://<owner>.github.io/<repo>/). UI-only by default: API_BASE_URL points at
# an unresolvable host, so data-driven sections render empty. To show live data,
# run with API_BASE_URL_PAGES=https://<your-api> (that API must allow STORE_URL in CORS).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="$(git -C "$ROOT" remote get-url origin)"
REPO_NAME="$(basename -s .git "$REPO_URL")"
OWNER="$(basename "$(dirname "$REPO_URL")" | sed 's/.*://')"

export VITE_BASE_PATH="/${REPO_NAME}/"
export STORE_URL="${STORE_URL_PAGES:-https://${OWNER}.github.io/${REPO_NAME}}"
export API_BASE_URL="${API_BASE_URL_PAGES:-https://api.invalid}"
export STORE_NAME="${STORE_NAME:-Bengali Exchange}"
export MERCHANT_PK="${MERCHANT_PK_PAGES:-pk_demo}"

cd "$ROOT/apps/client"
rm -rf dist
npm run build

cd dist
touch .nojekyll   # serve files/dirs that start with "_"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$ROOT" log -1 --format=%an)" -c user.email="$(git -C "$ROOT" log -1 --format=%ae)" \
  commit -q -m "Deploy client to GitHub Pages"
git push -f "$REPO_URL" gh-pages
rm -rf .git
echo "Published: ${STORE_URL}/"
