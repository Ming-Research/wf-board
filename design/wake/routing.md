Decision: A session holds an item while an engineer dispatch record on the item names it and has not ended, the newest start winning when several are open, and a push meant for the holder of an item goes to that session, because the start script writes the record and the finish ends it, so holding needs no call from the engineer and is never forgotten ([Where a push goes](../../docs/design.md#the-wake-streams)), instead of a claim and release tool that the engineer calls, or inferring the holder from who last wrote an item with a step in progress.

Decision: A deploy result and a red main line go to the session that holds the item whose changes section names the merged pull request, which is read from the commit's title, and when no session holds that item the failed deploy and the red main line go to the PM while a successful deploy goes nowhere, because the engineer that merged must act on the result, instead of every deploy going to the PM to forward or only the engineer of the last commit a deploy carried.

Rejected:
- A claim and release tool that the engineer calls: rejected because it adds two calls an engineer can forget and a second record that can disagree with the dispatch.
- Inferring the holder from who last wrote an item with a step in progress: rejected because one write by another session points the push at the wrong session.
- Pushing every deploy to the PM to forward: rejected because it hands the PM a message that it can only pass on.
- Telling only the engineer of the last commit of a deploy: rejected because it misses the other commits that the deploy carried.
