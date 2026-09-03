import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { isTcpPortAvailable, parseTcpPort } from "../../scripts/internal/tcp-port.mjs";

test("OpenCode launcher port preflight distinguishes free and occupied loopback ports", async () => {
  assert.throws(() => parseTcpPort("0", "opencode_port"), /opencode_port_invalid/);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(await isTcpPortAvailable(address.port), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isTcpPortAvailable(address.port), true);
});
