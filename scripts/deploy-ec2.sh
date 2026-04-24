#!/usr/bin/env bash
# Sincroniza o projeto com a EC2 via rsync (sem node_modules; instala dependências no servidor).
# Uso:
#   ./scripts/deploy-ec2.sh
#   EC2_HOST=1.2.3.4 SSH_KEY=/caminho/chave.pem ./scripts/deploy-ec2.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${EC2_HOST:=100.54.236.215}"
: "${EC2_USER:=ec2-user}"
: "${SSH_KEY:=$ROOT/daniel-private-key.pem}"
: "${REMOTE_PATH:=~/LLMValidator}"

if [[ ! -f "$SSH_KEY" ]]; then
  echo "Chave SSH não encontrada: $SSH_KEY"
  echo "Defina SSH_KEY=/caminho/para/sua-chave.pem"
  exit 1
fi

chmod 600 "$SSH_KEY" 2>/dev/null || true

RSYNC_EXCLUDES=(
  --exclude node_modules
  --exclude client/node_modules
  --exclude .git
  --exclude '*.pem'
  --exclude .DS_Store
  --exclude client/dist
)

echo "→ Sincronizando com ${EC2_USER}@${EC2_HOST}:${REMOTE_PATH}"
rsync -avz "${RSYNC_EXCLUDES[@]}" \
  -e "ssh -i \"$SSH_KEY\" -o StrictHostKeyChecking=accept-new" \
  "$ROOT/" "${EC2_USER}@${EC2_HOST}:${REMOTE_PATH}"

echo "→ Concluído. No servidor (Node 20+ — ver scripts/setup-node20-amazonlinux.sh):"
echo "    ssh -i \"$SSH_KEY\" ${EC2_USER}@${EC2_HOST}"
echo "    cd ~/LLMValidator && npm install && npm --prefix client install"
echo ""
echo "    Um comando (API + Vite na porta 80; o cliente sobe com sudo):"
echo "      cd ~/LLMValidator && npm run dev:ec2"
echo "    Abra http://${EC2_HOST}/ e libere a porta 80 no security group."
echo ""
echo "    Teste na própria EC2: curl -s http://127.0.0.1:3001/api/health"
echo "    curl -s http://127.0.0.1/api/health   (com Vite no ar)"
echo ""
echo "    Ollama: para aumentar requisições paralelas de verdade no GPU, defina"
echo "    OLLAMA_NUM_PARALLEL (ex.: systemd override). Ver:"
echo "    scripts/ollama-num-parallel-systemd.example.txt"
