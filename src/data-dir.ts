import { dirname, join, resolve } from "node:path";

// The board's data repository. WF_BOARD_DATA names it when set (a relative path is resolved
// against the current directory). Otherwise it sits beside the wf-board checkout: with the repo
// at ~/dev/wf/wf-board, the data is ~/dev/wf/wf-board-data, so moving ~/dev/wf moves both.
export function dataDir(repo: string, env: { WF_BOARD_DATA?: string } = process.env): string {
  return env.WF_BOARD_DATA ? resolve(env.WF_BOARD_DATA) : join(dirname(repo), "wf-board-data");
}
