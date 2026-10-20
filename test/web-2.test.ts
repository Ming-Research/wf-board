// The page in a fake DOM, part 2 of 2: every other test of test/web-cases.ts (test/deal.ts).

import { dealOut } from "./deal.ts";

dealOut(1, 2);
await import("./web-cases.ts");
