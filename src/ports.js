import net from 'node:net';

// Asks the OS for a free loopback port by binding port 0 and reading back what it assigned.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Maps each container port to a distinct free host port. We pick host ports ourselves (rather than
// letting Docker choose with `-p 127.0.0.1::PORT`) so they are known before the container starts
// and can be injected as CLAUDE_POD_PORT_<container> env vars.
export async function allocatePorts(containerPorts) {
  const used = new Set();
  const mappings = [];
  for (const container of containerPorts) {
    let host;
    do host = await freePort(); while (used.has(host));
    used.add(host);
    mappings.push({ container, host });
  }
  return mappings;
}
