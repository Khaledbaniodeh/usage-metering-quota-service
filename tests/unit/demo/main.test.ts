import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { demoFile } from "./demo-modules.js";

/** `npm run demo` runs exactly this file. */
const MAIN = fileURLToPath(demoFile("main.js"));

interface Run {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exit: Promise<number | null>;
}

function startMain(env: Readonly<Record<string, string>>): Run {
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, DEMO_HOST: "", DEMO_PORT: "", DEMO_API_BASE_URL: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = once(child, "exit").then(([code]) => code as number | null);
  return { child, stdout: () => stdout, stderr: () => stderr, exit };
}

/** Resolves with the address the demo printed once it is listening. */
async function waitForAddress(run: Run): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = /Interview demo UI: (http:\/\/127\.0\.0\.1:\d+)/.exec(run.stdout());
    if (match?.[1] !== undefined) {
      return match[1];
    }
    if (run.child.exitCode !== null) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the demo did not start; stderr: ${run.stderr()}`);
}

describe("npm run demo (demo/main.js)", () => {
  it("exits with code 2 and names each configuration problem without echoing values", async () => {
    const run = startMain({
      DEMO_HOST: "0.0.0.0",
      DEMO_API_BASE_URL: "http://someone:hidden-marker@127.0.0.1:8080",
    });

    expect(await run.exit).toBe(2);
    expect(run.stderr()).toContain("DEMO_HOST must be a loopback address");
    expect(run.stderr()).toContain("DEMO_API_BASE_URL must not contain credentials");
    expect(run.stderr()).not.toContain("hidden-marker");
    expect(run.stdout()).toBe("");
  });

  it("prints its address, serves the page and forwards to the configured API", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const { port } = upstream.address() as AddressInfo;
    const run = startMain({
      DEMO_PORT: "0",
      DEMO_API_BASE_URL: `http://127.0.0.1:${String(port)}`,
    });
    try {
      const address = await waitForAddress(run);

      const page = await fetch(`${address}/`);
      const live = await fetch(`${address}/health/live`);

      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await live.json()).toEqual({ status: "ok" });
      expect(run.stdout()).toContain(
        `Forwarding /health/live, /health/ready and /v1/* to http://127.0.0.1:${String(port)}`,
      );
      expect(run.stdout()).toContain("Press Ctrl+C to stop.");
    } finally {
      run.child.kill();
      await run.exit;
      upstream.closeAllConnections();
      upstream.close();
    }
  });

  it("exits with code 1 and a clear message when the port is taken", async () => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const { port } = blocker.address() as AddressInfo;
    try {
      const run = startMain({ DEMO_PORT: String(port) });

      expect(await run.exit).toBe(1);
      expect(run.stderr()).toContain(`Port ${String(port)} is already in use`);
    } finally {
      blocker.close();
    }
  });

  // Windows cannot deliver SIGINT or SIGTERM to a child process (kill() terminates it at once),
  // so the graceful stop is verified on Linux and macOS, including CI.
  it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
    "stops cleanly with exit code 0 on %s",
    async (signal) => {
      const run = startMain({ DEMO_PORT: "0" });
      await waitForAddress(run);

      run.child.kill(signal);

      expect(await run.exit).toBe(0);
      expect(run.stdout()).toContain(`Received ${signal}; stopping the demo server.`);
      expect(run.stdout()).toContain("Demo server stopped.");
      expect(run.stderr()).toBe("");
    },
  );
});
