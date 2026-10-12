// Process entry point of the Usage Metering and Quota Service.
//
// Implementation Phase 0 only establishes the project scaffolding and quality gates.
// The HTTP service is built in later phases (see docs/architecture.md). Until then this
// entry point reports that honestly and exits with a failure code instead of pretending
// to serve requests.

process.stderr.write(
  "usage-metering-quota-service: the service is not implemented yet (Phase 0 scaffolding only).\n",
);
process.exitCode = 1;
