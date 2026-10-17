import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dataDir } from "../src/data-dir.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the default data directory sits beside the checkout, so moving the parent moves both", () => {
  assert.equal(dataDir("/Users/owner/dev/wf/wf-board", {}), "/Users/owner/dev/wf/wf-board-data");
});

test("WF_BOARD_DATA overrides the default, and a relative value is made absolute", () => {
  assert.equal(dataDir(repo, { WF_BOARD_DATA: "/srv/board" }), "/srv/board");
  assert.equal(dataDir(repo, { WF_BOARD_DATA: "rel/board" }), resolve("rel/board"));
});

test("the installer writes the data directory into the service plist", async () => {
  // realpath: on macOS tmpdir() goes through /var, which is /private/var, so the paths would not match.
  const home = await realpath(await mkdtemp(join(tmpdir(), "wfb-home-")));
  try {
    const run = promisify(execFile);
    const plistPath = join(home, "Library/LaunchAgents/org.ming-research.wf-board.plist");
    const { WF_BOARD_DATA: _inherited, ...inherited } = process.env;
    const install = (extra: Record<string, string>, cwd: string) => run(process.execPath, [join(repo, "scripts/install-service.ts")], { cwd, env: { ...inherited, HOME: home, ...extra } });
    const dataLine = (path: string) => `<key>WF_BOARD_DATA</key><string>${path}</string>`;

    await install({}, home);
    assert.ok((await readFile(plistPath, "utf8")).includes(dataLine(join(dirname(repo), "wf-board-data"))));

    await install({ WF_BOARD_DATA: "rel/board" }, home);
    assert.ok((await readFile(plistPath, "utf8")).includes(dataLine(join(home, "rel/board"))));

    // The sessions watch is switched on by the claude command and the workspace the plist carries.
    await install({ WF_BOARD_CLAUDE: "/opt/bin/claude", WF_HOME: "/srv/wf" }, home);
    const plist = await readFile(plistPath, "utf8");
    assert.ok(plist.includes("<key>WF_BOARD_CLAUDE</key><string>/opt/bin/claude</string><key>WF_HOME</key><string>/srv/wf</string>"));
    assert.ok(!plist.includes("{{"), "every placeholder is filled");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
