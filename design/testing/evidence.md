Decision: Every unit check is shown to fail on the wrong input it guards, and each diagram check and each count that guards the jump limit is shown to fail on the part it protects, by an edit applied while the page is bundled that removes that part, and reports in a line that names what it waited for and what the page held, because a pass counts only if a wrong result would have failed it ([Evidence](../../docs/design.md#three-test-layers)), instead of a bare timeout or a page that did not start as the failure signal.

Decision: Every page fix keeps a browser witness that runs on the current page, where it must find nothing, and on a copy of the page with that fix reversed, where it must report the bug, and a witness whose edits no longer apply fails and is updated or retired deliberately, because a fix that nothing can see being undone could be undone unnoticed, instead of a regression test that only passes on the fixed page.

Rejected:
- A bare timeout or a page that did not start as the failure signal: rejected because it does not say what the check was waiting for.
- A regression test that only passes on the fixed page: rejected because it would pass just as well if the fix were never made.
