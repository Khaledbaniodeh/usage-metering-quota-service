import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fakeQuotaService, type FakeServiceOptions } from "../../helpers/fake-quota-service.js";

/**
 * The entry point as a separate process, exactly as the Compose service and `npm run
 * client:example` start it: the exit code is what Compose and CI see. The service is the in-memory
 * model behind a real local HTTP server, so no Docker or database is involved.
 */

interface ProcessRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runMain(apiBaseUrl: string): Promise<ProcessRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "client/main.ts"], {
      env: { ...process.env, API_BASE_URL: apiBaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length === 0 ? null : Buffer.concat(chunks).toString("utf8");
}

const servers: Server[] = [];

/** Serves the in-memory model over HTTP on a free loopback port; returns its root URL. */
async function serve(options: FakeServiceOptions = {}): Promise<string> {
  const service = fakeQuotaService(options);
  const server = createServer((request, response) => {
    void (async () => {
      const answer = await service.fetch(new URL(request.url ?? "/", "http://fake.invalid"), {
        method: request.method ?? "GET",
        headers: request.headers as Record<string, string>,
        body: await readBody(request),
        signal: new AbortController().signal,
      });
      response.writeHead(answer.status, {
        "content-type": answer.headers.get("content-type") ?? "text/plain",
      });
      response.end(await answer.text());
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        ),
    ),
  );
});

describe("client/main.ts exit codes", () => {
  it("exits 0 after the whole scenario passes", async () => {
    const result = await runMain(await serve());

    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(
      /^Example workflow passed: .+40 units used; walked 3\/3\/5 pages/m,
    );
    expect(result.code).toBe(0);
  });

  it("exits 1 when a required behavior is wrong", async () => {
    // The shared-limit rejection is reported at the user level.
    const url = await serve({
      tamper: (call, body, request) =>
        call === "POST /v1/consume" && request.body?.includes("-account-rejected") === true
          ? { ...(body as object), blockingLevel: "USER" }
          : body,
    });

    const result = await runMain(url);

    expect(result.stderr).toMatch(/^Example client failed at step "account-limit rejection": /);
    expect(result.stdout).not.toContain("Example workflow passed");
    expect(result.code).toBe(1);
  });

  it("exits 1 when the service is unreachable", async () => {
    const result = await runMain(`http://127.0.0.1:${String(await closedPort())}`);

    expect(result.stderr).toMatch(/^Example client failed at step "health": /);
    expect(result.code).toBe(1);
  });

  it("exits 2 for an invalid API_BASE_URL", async () => {
    const result = await runMain("not a url");

    expect(result.stderr).toBe(
      "Example client: API_BASE_URL must be an absolute http:// or https:// URL\n",
    );
    expect(result.code).toBe(2);
  });
});
