// Temporary (ci-split-big-tests): where the time of a rules-reuse test file goes. Deleted before the last full CI.
import * as current from "../src/rules.ts";
import { answers, liveSized, run } from "./rules-reuse.ts";

const mode = process.env.MODE ?? "full", ms = (from: number) => ((performance.now() - from) / 1000).toFixed(2);
let t = performance.now();
const board = liveSized();
console.log(`${mode}: liveSized ${ms(t)} s, ${Object.keys(board.s.items).length} items`);
t = performance.now();
if (mode === "replay") run(current, board, 20261018, 100, () => "");
else if (mode === "full") run(current, board, 20261018, 100, answers);
else if (mode === "answers") { const r = current.rules(board.s, board.start); for (let k = 0; k < 5; k++) { const a = performance.now(); answers(r, board.s); console.log(`answers from nothing #${k}: ${ms(a)} s`); } }
console.log(`${mode}: run ${ms(t)} s`);
