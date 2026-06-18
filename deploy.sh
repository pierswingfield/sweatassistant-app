#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Target Pi Info — read from environment or .deploy.env
PI_IP="${DEPLOY_PI_IP:-192.168.1.8}"
PI_USER="${DEPLOY_PI_USER:-pi}"
PI_DIR="${DEPLOY_PI_DIR:-/home/pi/psycleapp}"

echo "=== Starting Psycle PWA Deployment to Raspberry Pi ($PI_IP) ==="

# 1. Check/Generate SSH Key locally
SSH_KEY="$HOME/.ssh/id_ed25519"
if [ ! -f "$SSH_KEY" ]; then
    echo "[Local] SSH Key not found. Generating a new ed25519 key..."
    ssh-keygen -t ed25519 -N "" -f "$SSH_KEY"
else
    echo "[Local] Found existing SSH Key: $SSH_KEY"
fi

# 2. Check if we can already connect without a password
echo "[Connection] Checking passwordless SSH connection to $PI_USER@$PI_IP..."
if ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$PI_USER@$PI_IP" echo "Connection successful" >/dev/null 2>&1; then
    echo "[Connection] Passwordless SSH is already set up and working!"
else
    echo "[Connection] Passwordless SSH not active. Run 'ssh-copy-id $PI_USER@$PI_IP' manually to set it up."
    echo "[Connection] Aborting. Set up SSH key auth before deploying."
    exit 1
fi

# 3. Create target directory on Pi
echo "[Remote] Creating target directory $PI_DIR on the Pi..."
ssh "$PI_USER@$PI_IP" "mkdir -p $PI_DIR"

# 4. Rsync the codebase to Pi
echo "[Sync] Syncing workspace to Raspberry Pi..."
rsync -avz --delete \
    --exclude="node_modules" \
    --exclude="client/node_modules" \
    --exclude="client/dist" \
    --exclude=".git" \
    --exclude=".DS_Store" \
    --exclude="*.db" \
    --exclude="*.db-journal" \
    --exclude="*.log" \
    --exclude=".env" \
    --exclude="deploy.sh" \
    ./ "$PI_USER@$PI_IP:$PI_DIR/"

# 5. Handle environment variables on the Pi
echo "[Remote] Configuring .env file on Pi..."
# Check if .env already exists on the Pi
if ssh "$PI_USER@$PI_IP" "[ -f $PI_DIR/.env ]"; then
    echo "[Remote] Found existing .env file. Keeping existing configurations."
else
    echo "[Remote] Creating new .env file with generated secrets..."
    
    # Generate secure random strings using node locally
    JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    
    # Create the env content
    ENV_CONTENT=$(cat <<EOF
NODE_ENV=production
PORT=3000
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
VAPID_EMAIL=mailto:piers@wingfield.tech
EOF
)
    
    # Write the env content to the Pi
    ssh "$PI_USER@$PI_IP" "cat << 'EOF' > $PI_DIR/.env
$ENV_CONTENT
EOF"
    echo "[Remote] Created .env successfully."
fi

# 6. Run Docker Compose build and startup on the Pi
echo "[Docker] Rebuilding and starting docker containers on the Pi..."
ssh "$PI_USER@$PI_IP" "cd $PI_DIR && sudo docker compose down && sudo docker compose up -d --build"

# 7. Check container status
echo "[Verification] Checking container status..."
ssh "$PI_USER@$PI_IP" "cd $PI_DIR && sudo docker compose ps"

# Wait a few seconds for startup
echo "[Verification] Waiting for server startup (5s)..."
sleep 5

# Fetch logs
echo "[Verification] Printing last 20 lines of logs:"
ssh "$PI_USER@$PI_IP" "cd $PI_DIR && sudo docker compose logs --tail=20"

# Curl test
echo "[Verification] Performing local network test from Mac to Pi..."
if curl -s -o /dev/null -I -w "%{http_code}" --connect-timeout 5 "http://$PI_IP:3005" | grep -E "200|301|302|404" > /dev/null; then
    echo "🎉 Deployment successful! The server is up and listening on http://$PI_IP:3005"
else
    echo "⚠️ Server is running but connection check returned unexpected output or timed out. Check logs."
fi
