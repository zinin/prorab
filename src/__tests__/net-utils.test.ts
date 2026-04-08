import { describe, it, expect } from "vitest";
import { findFreePort } from "../core/net-utils.js";
import { createServer } from "node:net";

describe("findFreePort", () => {
  it("returns a valid port number", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
    expect(Number.isInteger(port)).toBe(true);
  });

  it("returns a port in the ephemeral range (not a well-known port)", async () => {
    // OS ephemeral port allocation always returns ports above the well-known
    // range (>= 1024). This is deterministic — listen(0) never returns a
    // privileged or well-known port like 3000.
    const port = await findFreePort();
    expect(port).toBeGreaterThanOrEqual(1024);
  });

  it("returns distinct ports on sequential calls", async () => {
    // Allocate several ports and verify we get more than one unique value.
    // Using a batch reduces the theoretical (but near-impossible) chance
    // of the OS reusing an immediately-freed ephemeral port.
    const ports = await Promise.all(
      Array.from({ length: 5 }, () => findFreePort()),
    );
    const unique = new Set(ports);
    expect(unique.size).toBeGreaterThan(1);
  });

  it("returns a port that can actually be bound", async () => {
    const port = await findFreePort();

    // Verify the port is usable by binding to it
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.listen(port, "127.0.0.1", () => resolve());
      srv.on("error", reject);
    });

    const addr = srv.address();
    expect(addr).not.toBeNull();
    expect(typeof addr === "object" && addr?.port).toBe(port);

    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});
