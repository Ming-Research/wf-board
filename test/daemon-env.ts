/** The environment a test gives the daemon it starts as a process (`src/main.ts`): the test's own with `extra` added, and without
 * Node's compile cache. The full CI sets `NODE_COMPILE_CACHE` for its test processes, and a process that has it writes its cache to
 * disk as it exits; for a daemon on a cold cache directory that was up to 1.5 s of its stop (1 of 192 runs of the shard that ran
 * `shutdown.test.ts`, the process waiting on the disk), and a test that times the stop took it for the daemon's. The service has no
 * compile cache (`ops/wf-board.plist`), so the daemon of a test runs as it does there (item shutdown-test-contention). */
export function daemonEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.NODE_COMPILE_CACHE;
  return env;
}
