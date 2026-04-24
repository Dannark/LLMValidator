Login AWS:
ssh -i daniel-private-key.pem ec2-user@100.54.236.215

npm run deploy:ec2
npm --prefix client run dev -- --host 0.0.0.0 --port 80

sudo systemctl restart ollama


pgrep -af node
ss -tlnp | grep 80

export OLLAMA_BASE_URL=http://98.81.97.115/:11434
npm run dev:server



npm run dev:ec2

cat /etc/os-release | grep PRETTY_NAME
sudo dnf install -y nvidia-release
sudo dnf install -y kernel-devel-$(uname -r) kernel-headers-$(uname -r)
sudo dnf install -y nvidia-driver-cudac

watch -n 1 nvidia-smi
