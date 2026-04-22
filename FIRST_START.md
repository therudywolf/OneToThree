# First Start Guide

A step-by-step guide for deploying Forest Messenger on a fresh VPS. This guide assumes Ubuntu 22.04 and a brand new server.

**[Русская версия → FIRST_START.ru.md](./FIRST_START.ru.md)**

---

## Table of Contents

- [1. Server Preparation](#1-server-preparation)
- [2. Install Docker](#2-install-docker)
- [3. Set Up DNS](#3-set-up-dns)
- [4. Configure Cloudflare (if used)](#4-configure-cloudflare-if-used)
- [5. Open Firewall Ports](#5-open-firewall-ports)
- [6. Clone the Repository](#6-clone-the-repository)
- [7. Run start.sh](#7-run-startsh)
- [8. Save Your Credentials](#8-save-your-credentials)
- [9. Verify Everything Works](#9-verify-everything-works)
- [10. Make Yourself Admin](#10-make-yourself-admin)
- [11. Install PWA on Your Phone](#11-install-pwa-on-your-phone)

---

## 1. Server Preparation

You need a Linux VPS with:

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB SSD | 40+ GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04/24.04 LTS |

Connect to your server via SSH:

```bash
ssh root@YOUR_SERVER_IP
```

Update the system:

```bash
apt update && apt upgrade -y
```

---

## 2. Install Docker

If Docker is not yet installed, run these commands:

```bash
# Install prerequisites
apt install -y ca-certificates curl gnupg

# Add Docker's official GPG key
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# Add the Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine + Compose plugin
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Verify the installation:

```bash
docker --version
# Docker version 27.x.x ...

docker compose version
# Docker Compose version v2.x.x ...
```

---

## 3. Set Up DNS

You need a domain (e.g., `messenger.example.com`) with four A records. Go to your DNS provider (or Cloudflare) and create these records:

```
example.com         →  A  →  YOUR_SERVER_IP
api.example.com     →  A  →  YOUR_SERVER_IP
s3.example.com      →  A  →  YOUR_SERVER_IP
turn.example.com    →  A  →  YOUR_SERVER_IP
```

**DNS propagation** can take up to 24 hours, but typically completes within minutes. Verify with:

```bash
dig +short example.com
dig +short api.example.com
dig +short s3.example.com
dig +short turn.example.com
```

All four should return your server's IP address.

---

## 4. Configure Cloudflare (if used)

If you use Cloudflare for DNS management, set the proxy mode for each record:

| Record | Proxy mode |
|--------|------------|
| `example.com` | Proxied (orange cloud) |
| `api.example.com` | Proxied (orange cloud) |
| `s3.example.com` | Proxied (orange cloud) |
| `turn.example.com` | **DNS only (gray cloud)** |

> **Why gray cloud for `turn.*`?** Cloudflare's proxy does not support UDP traffic. The TURN server needs direct UDP access for WebRTC call relay. If `turn.*` is proxied, voice and video calls will fail silently.

To change proxy mode in Cloudflare:
1. Go to your domain's DNS settings
2. Find the `turn.*` record
3. Click the orange cloud icon — it should turn gray
4. Save

Also ensure that your Cloudflare SSL/TLS mode is set to **Full (strict)** if you're proxying the other records. Caddy handles its own certificates, and Cloudflare must trust them.

---

## 5. Open Firewall Ports

```bash
# Web traffic (Caddy reverse proxy)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# TURN server (coturn)
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp

# TURN relay ports (WebRTC media)
sudo ufw allow 49152:65535/udp

# Enable firewall if not already active
sudo ufw enable
```

Verify:

```bash
sudo ufw status
```

You should see all the above ports listed as ALLOW.

---

## 6. Clone the Repository

```bash
git clone https://github.com/therudywolf/OneToThree.git
cd OneToThree
```

---

## 7. Run start.sh

```bash
chmod +x ./start.sh
./start.sh
```

### What each prompt means

The script will ask you four questions:

1. **Enter your domain (e.g. onetothree.ru):**
   Enter just the domain name without `https://`. Example: `messenger.example.com`

2. **Enter ACME email for TLS certs:**
   Your email address for Let's Encrypt certificate notifications. Example: `admin@example.com`

3. **Enter TURN server external IP:**
   Your server's public IP address. Find it with: `curl -s ifconfig.me`

4. **Enter VAPID contact email:**
   Contact email for push notifications. Can be the same as your ACME email. Example: `admin@example.com`

### What happens next

After answering the prompts, the script:
1. Generates all secrets and displays them in a box — **copy these now**
2. Creates `.env.prod` and fills in all values automatically
3. Pulls Docker images and builds the application (this takes several minutes)
4. Waits for each service to pass health checks
5. Prints the final status with your site URL

You'll see output like this:

```
  PostgreSQL     ✓ healthy
  MinIO          ✓ healthy
  API            ✓ healthy
  Next.js        ✓ healthy

  ✓ Forest Messenger launched

  Site:    https://messenger.example.com
  API:     https://api.messenger.example.com
  Server:  YOUR_SERVER_IP
```

---

## 8. Save Your Credentials

During the first run, you'll see a box like this:

```
╔══════════════════════════════════════════════════════════╗
║              SAVE THESE CREDENTIALS — SHOWN ONCE        ║
╠══════════════════════════════════════════════════════════╣
║ POSTGRES_PASSWORD  : ...
║ MINIO_PASSWORD     : ...
║ JWT_SECRET         : ...
║ WEBHOOK_SECRET     : ...
║ TURN_PASSWORD      : ...
║ VAPID_PUBLIC_KEY   : ...
║ VAPID_PRIVATE_KEY  : ...
╚══════════════════════════════════════════════════════════╝
```

**Copy all of these to a secure password manager immediately.** They are shown only once and cannot be retrieved later.

If you lose them:
1. Stop the stack: `./start.sh stop`
2. Delete secrets: `rm -rf ./secrets/`
3. Re-run: `./start.sh`
4. This generates new secrets — but **existing database data will be inaccessible** with a new DB password

---

## 9. Verify Everything Works

Run through this checklist:

- [ ] `./start.sh status` — all containers show "healthy" or "Up"
- [ ] Open `https://your-domain.com` in a browser — the registration page loads
- [ ] Check the TLS certificate — the lock icon shows a valid Let's Encrypt cert
- [ ] Register a new account — the registration flow completes successfully
- [ ] Send a test message to yourself (create a note/chat)
- [ ] Check `https://api.your-domain.com/health` — returns a response
- [ ] Test a voice call between two devices (requires two accounts)

If anything fails, check the [Troubleshooting](./README.md#troubleshooting) section in the README.

---

## 10. Make Yourself Admin

After registering your account, promote it to admin:

```bash
docker exec -it forestmessenger-db-1 psql -U forest -d forest \
  -c "UPDATE users SET role = 'admin' WHERE username = 'yourusername';"
```

Replace `yourusername` with the exact username you registered with.

Then open `https://your-domain.com/admin` while logged in. You should see the admin panel.

---

## 11. Install PWA on Your Phone

Forest Messenger is a Progressive Web App (PWA) — you can install it on your phone like a native app:

### Android (Chrome)
1. Open `https://your-domain.com` in Chrome
2. Tap the three-dot menu (top right)
3. Tap "Install app" or "Add to Home screen"
4. Confirm the installation

### iOS (Safari)
1. Open `https://your-domain.com` in Safari
2. Tap the Share button (bottom center)
3. Scroll down and tap "Add to Home Screen"
4. Tap "Add"

### Desktop (Chrome/Edge)
1. Open `https://your-domain.com`
2. Click the install icon in the address bar (or the three-dot menu → "Install Forest Messenger")

After installation, the app:
- Opens in its own window (no browser UI)
- Receives push notifications
- Works offline (shows a banner when the connection is lost)

---

## What's Next

- **Invite users** — share the registration link or have them search for your username
- **Set up backups** — run `./start.sh backup` regularly or set up a cron job
- **Keep updated** — run `./start.sh update` periodically to get new features and security fixes
- **Read the security model** — see [SECURITY.md](./SECURITY.md) for full details on the encryption architecture
