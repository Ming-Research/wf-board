# Temporary (merge-row-only): replaces the two decision lines of isMergeRow in src/rules.ts with $BODY.
import os
p = 'src/rules.ts'
lines = open(p).read().split('\n')
i = next(k for k, l in enumerate(lines) if l.startswith('  if (stageOf(row)?.kind === "merge") return true;'))
assert lines[i + 1].startswith('  return !plan.some')
lines[i:i + 2] = ['  ' + os.environ['BODY']]
open(p, 'w').write('\n'.join(lines))
