import { AsyncLocalStorage } from "node:async_hooks";

/** Where the time of one write call went (docs/design.md, section 4, Time limits): the steps in the order they ran, each with the
 * time since the one before it ended, so the steps add up to the call and nothing is counted twice. The places a write waits or
 * works end a step here (`lap`): the call's queue in src/ops.ts, the store's queue and each git command in src/store.ts. */
export class WriteTrace {
  private readonly steps: Array<{ name: string; ms: number; note?: string }> = [];
  private readonly clock: () => number;
  private mark: number;

  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
    this.mark = clock();
  }

  /** Ends a step: `name` took the time since the last step ended. `note` says more about it (what the wait was behind). */
  lap(name: string, note?: string): void {
    const now = this.clock();
    this.steps.push({ name, ms: now - this.mark, ...(note === undefined ? {} : { note }) });
    this.mark = now;
  }

  /** Ends the last step, `rest` (what the call did after its last step), and gives the steps as one line. A step that took less
   * than a millisecond is left out. */
  finish(): string {
    this.lap("rest");
    return this.steps.filter(step => Math.round(step.ms) >= 1).map(step => `${step.name} ${Math.round(step.ms)} ms${step.note === undefined ? "" : ` (${step.note})`}`).join(", ");
  }
}

const current = new AsyncLocalStorage<WriteTrace | undefined>();
/** The trace of the call the running code serves, or none for code no call is waiting on (a timer, the maintenance step). */
export const currentTrace = (): WriteTrace | undefined => current.getStore();
/** Runs `fn` for the call `trace` follows; none runs it for no call, whatever called it. */
export const withTrace = <T>(trace: WriteTrace | undefined, fn: () => T): T => current.run(trace, fn);
