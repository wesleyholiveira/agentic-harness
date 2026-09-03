import net from "node:net";

export function parseTcpPort(value, label = "port") {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label}_invalid:${normalized || "empty"}`);
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label}_invalid:${normalized}`);
  return port;
}

export function isTcpPortAvailable(port, host = "127.0.0.1") {
  const numericPort = parseTcpPort(port);
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port: numericPort, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
