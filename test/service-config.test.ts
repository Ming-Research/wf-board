// The service file templates (ops/*.plist) and what the installer and the deploy job do with them (src/service-config.ts,
// scripts/install-service.ts; docs/design.md, section 4, Deploying).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedValues, renderPlist } from "../src/service-config.ts";
import type { ServiceValues } from "../src/service-config.ts";

const root = join(import.meta.dirname, "..");
// Values an installer could be given that an XML text must spell out.
const tricky: ServiceValues = { NODE: "/opt/node <24>/bin/node", REPO: "/Users/me/dev/wf-board", HOME: "/Users/me", PATH: "/opt/bin:/usr/bin:/a&b:/q\"x'y", DATA: "/Users/me/data{{PATH}}" };

test("a template is filled in with its values written for XML, in one pass, so a value that looks like a placeholder stays as it is", () => {
  const out = renderPlist("<string>{{NODE}}</string><string>{{DATA}}</string><string>{{NODE}}</string>", tricky);
  assert.equal(out, "<string>/opt/node &lt;24&gt;/bin/node</string><string>/Users/me/data{{PATH}}</string><string>/opt/node &lt;24&gt;/bin/node</string>");
});

test("a placeholder no value fills is refused, not left in the file", () => {
  assert.throws(() => renderPlist("<string>{{NODE}}{{FLAGS}}</string>", tricky), /placeholder \{\{FLAGS\}\}, which no value fills/);
});

test("what the installer chose is read back from the daemon's service file in the repository, for any value", async () => {
  const text = renderPlist(await readFile(join(root, "ops/wf-board.plist"), "utf8"), tricky);
  const { HOME: _home, ...chosen } = tricky;
  assert.deepEqual(installedValues(text), chosen);
});

test("a service file that lacks a value the job needs is named, not guessed at", async () => {
  const text = renderPlist(await readFile(join(root, "ops/wf-board.plist"), "utf8"), tricky);
  for (const [cut, name] of [
    [/<key>WorkingDirectory<\/key><string>[^<]*<\/string>/, /WorkingDirectory/],
    [/<key>PATH<\/key><string>[^<]*<\/string>/, /PATH in its EnvironmentVariables/],
    [/<key>WF_BOARD_DATA<\/key><string>[^<]*<\/string>/, /WF_BOARD_DATA/],
    [/<key>ProgramArguments<\/key>/, /program \(the first of its ProgramArguments\)/],
  ] as const) {
    assert.ok(cut.test(text), `${cut} is in the file the test starts from`);
    assert.throws(() => installedValues(text.replace(cut, "")), name);
  }
});

test("the installer writes a service file the deploy job reads the installed values from, and the one it renders from the same template matches it", async t => {
  const home = await mkdtemp(join(tmpdir(), "wf-board-install-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { ...process.env, HOME: home, WF_BOARD_NODE: "/opt/node <24>/bin/node", WF_BOARD_PATH: "/opt/bin:/a&b", WF_BOARD_DATA: join(home, "data") };
  const out = execFileSync(process.execPath, [join(root, "scripts/install-service.ts")], { env, encoding: "utf8" });
  const file = join(home, "Library/LaunchAgents/org.ming-research.wf-board.plist");
  assert.match(out, new RegExp(`^launchctl bootstrap gui/${process.getuid!()} '`));
  const installed = await readFile(file, "utf8");
  const chosen = installedValues(installed);
  assert.deepEqual(chosen, { NODE: "/opt/node <24>/bin/node", REPO: root, PATH: "/opt/bin:/a&b", DATA: join(home, "data") });
  // The job renders the repository's template with those values and the home it runs as: the file it finds installed is that text exactly.
  assert.equal(renderPlist(await readFile(join(root, "ops/wf-board.plist"), "utf8"), { ...chosen, HOME: home }), installed);
});
