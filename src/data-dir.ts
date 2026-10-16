import { dirname, join } from "node:path";

// The board's data repository sits beside the wf-board checkout: with the repo at
// ~/dev/wf/wf-board, the data is ~/dev/wf/wf-board-data. Moving the whole ~/dev/wf
// directory moves both together. WF_BOARD_DATA overrides it.
export function defaultDataDir(repo: string): string {
  return join(dirname(repo), "wf-board-data");
}
