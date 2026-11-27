/**
 * `npm run demo`: starts the optional interview demo UI and stops it on Ctrl+C.
 *
 * Exit codes: 0 after a normal stop, 1 when the server cannot start (for example the port is in
 * use), 2 for invalid configuration. Configuration comes only from DEMO_HOST, DEMO_PORT and
 * DEMO_API_BASE_URL; no .env file and no database setting is read.
 */
import process from "node:process";
import { DemoConfigError, loadDemoConfig, startDemoServer } from "./server.js";

const out = (line) => {
  process.stdout.write(`${line}\n`);
};
const err = (line) => {
  process.stderr.write(`${line}\n`);
};

async function main() {
  let config;
  try {
    config = loadDemoConfig(process.env);
  } catch (error) {
    if (error instanceof DemoConfigError) {
      err(error.message);
      return 2;
    }
    throw error;
  }

  // The shutdown handlers exist before the server listens, so no SIGINT or SIGTERM can arrive
  // while the demo is reachable or has printed its address but cannot yet stop cleanly.
  let server;
  let stopSignal;
  const { promise: stopped, resolve: markStopped } = Promise.withResolvers();
  const stop = (signal) => {
    stopSignal = signal;
    out(`Received ${signal}; stopping the demo server.`);
    if (server !== undefined) {
      void server.close().then(markStopped);
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    server = await startDemoServer(config, { log: (line) => out(`[demo] ${line}`) });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "unknown error";
    err(
      code === "EADDRINUSE"
        ? `Port ${String(config.port)} is already in use on ${config.host}. Stop the other process or set DEMO_PORT.`
        : `The demo server could not start (${code}).`,
    );
    return 1;
  }

  if (stopSignal === undefined) {
    out(`Interview demo UI: ${server.url}`);
    out(`Forwarding /health/live, /health/ready and /v1/* to ${config.apiBaseUrl}`);
    out("API keys stay in the browser's memory; this server never logs or stores them.");
    out("Press Ctrl+C to stop.");
    await stopped;
  } else {
    // A signal arrived while the server was starting: stop without announcing it.
    await server.close();
  }
  out("Demo server stopped.");
  return 0;
}

process.exitCode = await main();
