#!/usr/bin/env bash
# Deploy or roll back the API on the server.
#   ./deploy.sh              pull and run the :latest image
#   ./deploy.sh <git-sha>    pin the API to that image tag (rollback)
# Waits up to 90 s for the API's /health (checked inside the api container, so no host curl is needed);
# exits non-zero if it never answers.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [ "${1:-}" != "" ]; then
  if ! [[ "$1" =~ ^[A-Za-z0-9_.-]{1,128}$ ]]; then
    echo "invalid tag: $1" >&2
    exit 2
  fi
  export API_TAG="$1"
fi
echo "deploying nanite-api:${API_TAG:-latest}"

docker compose pull api
docker compose up -d
docker image prune -f >/dev/null

deadline=$((SECONDS + 90))
until docker compose exec -T api node -e "fetch('http://127.0.0.1:4000/health',{signal:AbortSignal.timeout(4000)}).then(async r=>{const b=await r.json();process.exit(r.ok&&b.ok===true?0:1)},()=>process.exit(1))" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "FAILED: /health did not answer within 90 s. Logs: docker compose logs --tail 100 api" >&2
    docker compose ps >&2 || true
    exit 1
  fi
  sleep 3
done

echo "api healthy (image tag ${API_TAG:-latest})."
if [ "${1:-}" != "" ]; then
  echo "Rollback note: add API_TAG=$1 to .env so a later 'docker compose up' keeps this tag; remove it to follow :latest again."
fi
docker compose ps
