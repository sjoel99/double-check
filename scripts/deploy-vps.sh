#!/usr/bin/env bash
# Atualiza o Dupla Chave (devnet) na VPS: build do app, envia código + build e
# reconstrói a API. Não mexe em banco, chaves nem .env (ficam só na VPS).
# NÃO rodar perto da rotina do solbalance (00h05 e 13h UTC).
set -euo pipefail
cd "$(dirname "$0")/.."
VITE_CLUSTER=devnet VITE_RPC_URL=/rpc pnpm --filter @duplachave/approval-web build
rsync -az --delete --exclude node_modules --exclude .data --exclude '.env*' --exclude dist --exclude .git --exclude .surfpool --exclude coverage ./ contabo:/root/duplachave/src/
rsync -az --delete apps/approval-web/dist/ contabo:/root/duplachave/dist/
ssh contabo 'docker compose -f /root/duplachave/src/deploy/docker-compose.yml --env-file /root/duplachave/deploy/.env up -d --build 2>&1 | tail -3; sleep 5; docker exec duplachave wget -qO- http://127.0.0.1/api/v1/config'
