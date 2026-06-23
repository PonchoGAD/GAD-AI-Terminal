#!/bin/bash
# deploy-service.sh <service-name>
# Usage: bash scripts/deploy-service.sh base-scanner
#        bash scripts/deploy-service.sh autobuy
#        bash scripts/deploy-service.sh polymarket-bot
#
# Pulls latest source from git, copies into running container, recompiles dist,
# then restarts. Does NOT require docker compose build (no disk usage).
#
# PERSISTENCE: Run this after EVERY docker compose up -d --no-deps <service>
# to keep source patches alive.

set -e

SERVICE="${1:-}"
if [ -z "$SERVICE" ]; then
  echo "Usage: bash scripts/deploy-service.sh <service-name>"
  echo "  Services: base-scanner autobuy polymarket-bot telegram social-monitor scanner"
  exit 1
fi

CONTAINER="gad-ai-${SERVICE}"
REPO="/opt/gad-ai-terminal/GAD-AI-Terminal"
SRC="${REPO}/services/${SERVICE}/src"

echo "=== Deploying ${SERVICE} ==="
echo "→ git pull..."
cd "$REPO"
git pull origin main

echo "→ Checking container ${CONTAINER}..."
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "⚠️  Container ${CONTAINER} not running — starting it..."
  docker compose up -d --no-deps "${SERVICE}"
  sleep 3
fi

echo "→ Copying source files into container..."
docker cp "${SRC}/." "${CONTAINER}:/usr/src/app/services/${SERVICE}/src/"

echo "→ Building inside container..."
docker exec "${CONTAINER}" sh -c \
  "cd /usr/src/app && npm --workspace services/${SERVICE} run build 2>&1 | tail -5"

echo "→ Restarting ${CONTAINER}..."
docker restart "${CONTAINER}"
sleep 2

echo "✅ ${SERVICE} deployed successfully"
echo "   Logs: docker logs ${CONTAINER} --tail=20"
