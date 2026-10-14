/**
 * Example client entry point: `npm run client:example`. Runs the example workflow against
 * API_BASE_URL (default http://127.0.0.1:8080) and exits with 0 on success, 1 when the workflow
 * fails and 2 for invalid configuration.
 */
import { runCli } from "./cli.js";

process.exitCode = await runCli({
  env: process.env,
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
});
