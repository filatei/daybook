# Daybook — connecting the live fido POS sales (read-only)

End state: Daybook reaches fido's MongoDB over a locked-down SSH tunnel with a
**read-only** user, so it can pull sales, let the AI analyse them, and (optionally)
sync nightly. Nothing on fido is exposed publicly.

```
Daybook server ──ssh:2525 (tunnel)──► fido.torama.ng  127.0.0.1:27017 (mongod)
   127.0.0.1:27018  ◄── read-only ──   fido_db.fidoorders
```

---

## 0. Push the latest code (on your Mac)

```bash
cd ~/Documents/Claude/Projects/Daybook
git push
```

## 1. Install the tunnel on the Daybook server (from your Mac)

```bash
cd ~/Documents/Claude/Projects/Daybook
bash scripts/bootstrap.sh
```

This installs `autossh`, generates the tunnel key, and **prints a public key**
under "Sales source not yet active". Copy that whole `ssh-ed25519 …` line.

## 2. On fido.torama.ng — authorise the key + create a read-only DB user

SSH into fido (port 2525) as a sudo-capable user:

```bash
ssh -p 2525 <you>@fido.torama.ng
```

### 2a. Create a locked-down tunnel user and authorise the key

```bash
sudo useradd -m -s /bin/sh daybooktunnel
sudo mkdir -p /home/daybooktunnel/.ssh && sudo chmod 700 /home/daybooktunnel/.ssh

# Paste the key from step 1 in place of ssh-ed25519 AAAA...  (keep the prefix!)
echo 'restrict,permitopen="127.0.0.1:27017",port-forwarding ssh-ed25519 AAAA...PASTE_KEY... daybook-mongo-tunnel' \
  | sudo tee /home/daybooktunnel/.ssh/authorized_keys

sudo chown -R daybooktunnel:daybooktunnel /home/daybooktunnel/.ssh
sudo chmod 600 /home/daybooktunnel/.ssh/authorized_keys
```

`restrict,permitopen="127.0.0.1:27017",port-forwarding` means this key can do
**nothing** except forward to the local mongod — no shell, no other ports.

### 2b. Create the read-only Mongo user

Use fido's existing admin credentials (they're in `tor-pos-backend/.env`):

```bash
mongosh "mongodb://localhost:27017/?replicaSet=rs0" -u <adminUser> -p
```
```js
use admin
db.createUser({
  user: "daybook_ro",
  pwd:  "<STRONG_PASSWORD>",
  roles: [ { role: "read", db: "fido_db" } ]
})
exit
```

### 2c. Confirm fido allows the Daybook server in on 2525

The Daybook server's IP is **139.162.170.253**. Make sure fido's firewall lets it
reach port 2525 (you said 2525 is already open — just confirm for that IP).

## 3. On the Daybook server — set the connection + enable

```bash
ssh otuburu                       # the Daybook box
sudo nano /opt/daybook/backend/.env
```
Set these (replace the password):

```ini
FIDO_SSH_USER=daybooktunnel
SALES_MONGO_URL=mongodb://daybook_ro:<STRONG_PASSWORD>@127.0.0.1:27018/fido_db?authSource=admin&directConnection=true&readPreference=secondaryPreferred

# optional — nightly snapshot of every site's sales into Daybook reports:
SYNC_ENABLED=1
SYNC_EMAIL=0                      # set 1 to also email each report to recipients

# optional — turn on the AI assistant + POS Q&A:
AI_API_KEY=sk-ant-...
```

Then bring it all up:

```bash
sudo systemctl enable --now daybook-mongo-tunnel
daybook-deploy
```

(Or just re-run `bash scripts/bootstrap.sh` from your Mac — it does the same.)

## 4. Verify

```bash
# tunnel listening on the Daybook server?
ss -ltnp | grep 27018                       # expect 127.0.0.1:27018 LISTEN
sudo systemctl status daybook-mongo-tunnel   # active (running)
docker logs --tail 20 daybook                # look for the [sync] line
```

In the app (as superadmin/admin):
- Open a report → **⤓ Pull from sales DB** → real product lines + cash/transfer fill in.
- A report's **✨ Analyse** button, and the **✨ assistant** can now answer
  questions like "which site sold most this week?".
- **Staff → ⤓ Import from POS** brings in the real crew.
- Force a sync any time (superadmin): `POST /api/sync/run` `{ "date": "2026-06-13" }`.

## Rotate / revoke

- Revoke access: remove the line from `/home/daybooktunnel/.ssh/authorized_keys`
  on fido, or `db.dropUser("daybook_ro")` in Mongo.
- The read-only user can never write to fido. The tunnel key can only forward to
  the local mongod.
