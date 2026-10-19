import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { server } from "./helpers.ts";

test("a server over a board is closed while the board's directory still exists, and the directory goes after", async t => {
  const dirExistedAtClose: boolean[] = [];
  let dir = "";
  // The hooks of a subtest run when it ends, so the order they run in shows here.
  await t.test("a board with its server", async inner => {
    const fixture = await server(inner);
    dir = fixture.dir;
    const close = fixture.http.close.bind(fixture.http);
    fixture.http.close = ((callback?: (error?: Error) => void) => { dirExistedAtClose.push(existsSync(fixture.dir)); return close(callback); }) as typeof fixture.http.close;
  });
  assert.deepEqual(dirExistedAtClose, [true], "the server closes before the directory is removed");
  assert.equal(existsSync(dir), false, "the directory is removed when the test ends");
});
