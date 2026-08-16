#!/usr/bin/env bash
#
# Publish the stack on a public hostname through a Cloudflare tunnel.
#
#   cloudflared tunnel login          # once, in a browser — you must do this
#   scripts/go-live.sh watch.abhigyanverma.com
#
# This is the point where the app stops being a LAN toy and becomes reachable
# from the internet, so it does three things in order and refuses to skip any:
#
#   1. Verifies you are authenticated to Cloudflare.
#   2. Creates the tunnel and the DNS record.
#   3. Flips the app to production settings — and this is the part people forget:
#        COOKIE_SECURE=true          session cookies stop travelling in the clear
#        TRUST_CF_CONNECTING_IP=true rate limiting starts seeing real client IPs
#        GATE_BIND=127.0.0.1         nothing is exposed on the host or the LAN
#
# Re-runnable: an existing tunnel or DNS record is reused, not duplicated.
set -uo pipefail

HOSTNAME_ARG="${1:-}"
TUNNEL_NAME="${2:-jellyfin-gate}"

if [ -z "$HOSTNAME_ARG" ]; then
  echo "usage: $0 <hostname> [tunnel-name]" >&2
  echo "   eg: $0 watch.abhigyanverma.com" >&2
  exit 1
fi

cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$PATH"

command -v cloudflared >/dev/null || { echo "cloudflared not found on PATH" >&2; exit 1; }

DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sg docker -c"
# `sg docker -c` takes a single string, so every argument has to be re-quoted
# with printf %q. Interpolating "$*" instead word-splits things like
# --format '{{.Service}}  {{.State}}' and docker reads the fragments as
# service names.
run_docker() {
  if [ "$DOCKER" = "docker" ]; then
    docker "$@"
  else
    sg docker -c "$(printf '%q ' docker "$@")"
  fi
}

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- 1. authentication ------------------------------------------------------
step "1. Cloudflare authentication"
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  cat >&2 <<EOF
  Not authenticated.

  Run this yourself — it opens a browser and asks you to pick the zone. It uses
  your Cloudflare login, which is not something this script should handle:

      cloudflared tunnel login

  Then run this script again.
EOF
  exit 1
fi
echo "  authenticated (cert.pem present)"

# --- 2. tunnel and DNS ------------------------------------------------------
step "2. Tunnel and DNS"
# --output json rather than parsing the human table: that table carries a
# prose header line and column titles, so positional awk is one cloudflared
# release away from silently matching the wrong field.
tunnel_id_for() {
  cloudflared tunnel list --output json 2>/dev/null \
    | node -e '
        let raw = "";
        process.stdin.on("data", (d) => (raw += d));
        process.stdin.on("end", () => {
          try {
            const list = JSON.parse(raw || "[]");
            // deleted_at "0001-01-01T00:00:00Z" is the Go zero time, meaning
            // NOT deleted. A real timestamp there means the tunnel is gone.
            // (No apostrophes in here: this block sits inside a single-quoted
            // shell argument.)
            const live = (t) => !t.deleted_at || t.deleted_at.startsWith("0001-");
            const hit = list.find((t) => t.name === process.argv[1] && live(t));
            process.stdout.write(hit ? hit.id : "");
          } catch {
            process.stdout.write("");
          }
        });
      ' "$1"
}

TUNNEL_ID=$(tunnel_id_for "$TUNNEL_NAME")
if [ -n "$TUNNEL_ID" ]; then
  echo "  tunnel '$TUNNEL_NAME' already exists — reusing it"
else
  cloudflared tunnel create "$TUNNEL_NAME" || exit 1
  TUNNEL_ID=$(tunnel_id_for "$TUNNEL_NAME")
  echo "  tunnel '$TUNNEL_NAME' created"
fi
[ -z "$TUNNEL_ID" ] && { echo "  could not determine tunnel id" >&2; exit 1; }
echo "  id: $TUNNEL_ID"

# Idempotent: re-pointing an existing record at the same tunnel is a no-op.
cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$HOSTNAME_ARG" \
  && echo "  DNS: $HOSTNAME_ARG -> $TUNNEL_ID" \
  || echo "  DNS route already in place (or could not be changed) — continuing"

# --- 3. tunnel config -------------------------------------------------------
step "3. Tunnel config"
# credentials-file uses the in-container path: the compose service mounts
# ~/.cloudflared at /etc/cloudflared.
cat > "$HOME/.cloudflared/config.yml" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: ${HOSTNAME_ARG}
    # Reached over the compose network, not the host: the gateway does not need
    # to publish a port for this to work.
    service: http://gate:3000
    originRequest:
      # Video responses are long-lived. The default 30s idle timeout would cut
      # a paused stream; 90s tolerates a stalled client without leaking
      # connections.
      connectTimeout: 30s
      tcpKeepAlive: 30s
      keepAliveTimeout: 90s
      # No response buffering — this carries video and must stream.
      httpHostHeader: ${HOSTNAME_ARG}
  - service: http_status:404
EOF
echo "  wrote ~/.cloudflared/config.yml"

# --- 4. production settings -------------------------------------------------
step "4. Production settings"
python3 - "$HOSTNAME_ARG" <<'PY'
import pathlib, re, sys
host = sys.argv[1]
p = pathlib.Path(".env")
s = p.read_text() if p.exists() else ""
def setkv(s, k, v):
    return re.sub(rf"^{k}=.*$", f"{k}={v}", s, flags=re.M) if re.search(rf"^{k}=", s, re.M) else s + f"{k}={v}\n"
before = dict(re.findall(r"^(\w+)=(.*)$", s, re.M))
s = setkv(s, "PUBLIC_URL", f"https://{host}")
s = setkv(s, "COOKIE_SECURE", "true")
s = setkv(s, "TRUST_CF_CONNECTING_IP", "true")
s = setkv(s, "GATE_BIND", "127.0.0.1")
p.write_text(s)
after = dict(re.findall(r"^(\w+)=(.*)$", s, re.M))
for k in ("PUBLIC_URL", "COOKIE_SECURE", "TRUST_CF_CONNECTING_IP", "GATE_BIND"):
    old = before.get(k, "(unset)")
    print(f"  {k}: {old} -> {after[k]}" if old != after[k] else f"  {k}: {after[k]} (unchanged)")
PY

# The tunnel container must run as the owner of ~/.cloudflared to read the
# credentials, which are deliberately 0600 inside a 0700 directory.
python3 - "$(id -u)" "$(id -g)" <<'ENVPY'
import pathlib, re, sys
p = pathlib.Path(".env"); s = p.read_text() if p.exists() else ""
def setkv(s, k, v):
    return re.sub(rf"^{k}=.*$", f"{k}={v}", s, flags=re.M) if re.search(rf"^{k}=", s, re.M) else s + f"{k}={v}\n"
s = setkv(s, "CF_UID", sys.argv[1])
s = setkv(s, "CF_GID", sys.argv[2])
p.write_text(s)
print(f"  CF_UID/CF_GID: {sys.argv[1]}:{sys.argv[2]} (owner of ~/.cloudflared)")
ENVPY
# --- 5. restart -------------------------------------------------------------
step "5. Restarting"
run_docker compose up -d --force-recreate gate worker tunnel >/dev/null 2>&1
sleep 12
run_docker compose ps --format '  {{.Service}}  {{.State}}'

# --- 6. verify --------------------------------------------------------------
step "6. Verification"
LANIP=$(hostname -I | awk '{print $1}')
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://${LANIP}:3000/login" 2>/dev/null)
[ "$code" = "000" ] && echo "  LAN 3000 closed (correct)" || echo "  WARNING: still reachable on the LAN at ${LANIP}:3000 (got $code)"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://${LANIP}:8096/System/Info/Public" 2>/dev/null)
[ "$code" = "000" ] && echo "  LAN 8096 closed (correct)" || echo "  WARNING: Jellyfin reachable on the LAN (got $code)"

echo "  waiting for DNS and the tunnel to settle…"
for i in $(seq 1 20); do
  sleep 6
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${HOSTNAME_ARG}/login" 2>/dev/null)
  echo "    attempt $i: https://${HOSTNAME_ARG}/login -> ${code}"
  [ "$code" = "200" ] && break
done

if [ "$code" = "200" ]; then
  cookie=$(curl -s -D- -o /dev/null --max-time 10 -X POST "https://${HOSTNAME_ARG}/api/auth/login" \
    -H 'Content-Type: application/json' -d '{"username":"x","password":"y"}' 2>/dev/null \
    | grep -i '^set-cookie' | tr -d '\r')
  case "$cookie" in
    *Secure*) echo "  session cookie carries Secure (correct for https)";;
    "")       echo "  (no cookie on a failed login, as expected)";;
    *)        echo "  WARNING: cookie is missing Secure — check COOKIE_SECURE";;
  esac
  printf '\n\033[1mLive at https://%s\033[0m\n' "$HOSTNAME_ARG"
else
  printf '\n  Not answering yet. Check: %s\n' "docker compose logs tunnel --tail 30"
fi
