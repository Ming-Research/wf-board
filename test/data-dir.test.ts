import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultDataDir } from "../src/data-dir.ts";

test("the default data directory sits beside the checkout, so moving the parent moves both", () => {
  assert.equal(defaultDataDir("/Users/owner/dev/wf/wf-board"), "/Users/owner/dev/wf/wf-board-data");
});
