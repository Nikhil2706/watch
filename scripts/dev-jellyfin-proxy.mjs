import net from "node:net";

/**
 * Publishes Jellyfin on the host, for a development machine on the LAN.
 *
 * Why this exists at all: `next dev` on a second computer has to reach
 * Jellyfin, and the jellyfin service deliberately has no `ports:` block —
 * it sits on the internal compose network, and only the gate can talk to it.
 * That posture is worth keeping, so this opens one door rather than removing
 * the wall.
 *
 * Why a separate container rather than a ports: entry on the service itself:
 * this is purely additive. If it fails, it fails alone. A compose file that
 * referenced a service which no longer existed once made `compose up` exit 1
 * and start NOTHING for eight days, and anything added to the boot path
 * inherits that risk. This cannot take the site down.
 *
 * Why not socat: pulling alpine/socat needs Docker Hub, and DNS from this
 * host's WSL distro fails often enough that a deployment step should not
 * depend on it. node:22-alpine is already on disk because the app is built
 * from it, and a TCP splice is fifteen lines.
 *
 * Run it (from WSL, on the internal network, publishing 8096):
 *
 *   docker run -d --name jf-lan --restart unless-stopped \
 *     --network jellyfin-gate_internal -p 8096:8096 \
 *     -v /mnt/c/Users/Dell/Downloads/jellyfin-gate/scripts:/s:ro \
 *     node:22-alpine node /s/dev-jellyfin-proxy.mjs
 *
 * Publishing inside WSL only reaches the WSL VM. Getting from there to the
 * Wi-Fi address needs a Windows-side portproxy and a firewall rule for the
 * private profile; both are in DEV-PC-SETUP.md's companion notes.
 *
 * To remove every trace: docker rm -f jf-lan.
 */

const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 8096);
const TARGET_HOST = process.env.TARGET_HOST ?? "jellyfin";
const TARGET_PORT = Number(process.env.TARGET_PORT ?? 8096);

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST);

  client.pipe(upstream);
  upstream.pipe(client);

  // Either side going away takes the other with it. Without this a half-open
  // socket lingers for every dropped phone connection, and a browsing session
  // opens a great many of them.
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
});

server.on("error", (error) => {
  // Loud and fatal: a proxy that is quietly not listening is worse than one
  // that is obviously dead, because the dev machine's failure looks like a
  // Jellyfin problem instead.
  console.error(`[jf-lan] cannot listen on ${LISTEN_PORT}:`, error.message);
  process.exit(1);
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`[jf-lan] :${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
