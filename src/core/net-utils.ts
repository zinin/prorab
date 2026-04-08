import { createServer } from "node:net";

/**
 * Find a free TCP port by briefly binding to port 0.
 *
 * Use this instead of hardcoding port numbers (e.g. 3000) whenever
 * starting a local server — in tests, integration checks, or agent
 * sessions that need a `--port` value.
 *
 * @returns A port number guaranteed to have been free at allocation time.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not allocate free port")));
      }
    });
    srv.on("error", reject);
  });
}
