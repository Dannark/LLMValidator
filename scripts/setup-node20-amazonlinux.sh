#!/usr/bin/env bash
# Amazon Linux 2023: instala Node.js 20 LTS (NodeSource).
# O Vite 8+ exige Node ^20.19.0 ou >=22.12.0 — o pacote `dnf install nodejs` da Amazon costuma ser 18.x.
# Executar na EC2: bash scripts/setup-node20-amazonlinux.sh

set -euo pipefail

if command -v node >/dev/null 2>&1; then
  major=$(node -p "parseInt(process.version.slice(1).split('.')[0], 10)")
  if [[ "$major" -ge 20 ]]; then
    echo "Node $(node -v) já é adequado para o Vite 8+."
    exit 0
  fi
fi

curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf remove -y nodejs nodejs-npm nodejs-docs nodejs-full-i18n nodejs-libs 2>/dev/null || true
sudo dnf install -y nodejs
node -v
npm -v
