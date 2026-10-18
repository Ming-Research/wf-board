Decision: The limit of 0.2 seconds for the jump to the next unread change is guarded in two layers on a board of the live board's weight: exact counts that hold on any machine (no rebuild of the rules, no filter count, at most two draws, with the answer delays of the baselines set by the test), and a time over 30 landings (median at most 0.2 seconds and 90th percentile at most 0.3 seconds, quiet and under writes), because the time depends on the runner, which varies up to a factor of two between jobs, while the counts do not ([Three test layers](../../docs/design.md#three-test-layers)), instead of a time limit alone.

Rejected:
- A time limit alone: rejected because the time depends on the runner and varies up to a factor of two between jobs.
