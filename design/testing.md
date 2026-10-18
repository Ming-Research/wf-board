Decision: The board is tested in three layers: rules, store and server tests, the bundled page in a hand-written fake DOM, and the page in headless Chromium against the real server on a temporary data repository, where the browser layer runs on a board generated from a seed whose shapes come from a survey of the real board and are each required by a test of the first layer, no real text being copied, and its click checks compare where the page lands with what is computed independently from the stored board by the rules module and the server's unread history, because five page bugs in one day passed the first two layers ([Three test layers](../docs/design.md#three-test-layers)), instead of tests in the fake DOM alone or fixtures copied from the real board.

Rejected:
- The fake DOM alone: rejected because it computes no CSS or real layout and its fixtures hold few real shapes.
- Fixtures copied from the real board: rejected because real board data never enters this repository.
