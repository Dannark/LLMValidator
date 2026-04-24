Login AWS:
ssh -i daniel-private-key.pem ec2-user@34.228.57.240

npm run deploy:ec2
npm --prefix client run dev -- --host 0.0.0.0 --port 80


pgrep -af node
ss -tlnp | grep 80

export OLLAMA_BASE_URL=http://98.81.97.115/:11434
npm run dev:server
