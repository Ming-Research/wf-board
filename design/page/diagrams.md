Decision: A diagram fence is drawn by the pinned mermaid library, which is bundled as a file of its own and loaded only when a diagram is first met, in strict mode, because board text is written by agents and strict mode makes the text of a diagram plain text and leaves out click handlers, and a page without a diagram should not fetch the library ([Diagrams](../../docs/design.md#7-the-page)), instead of loading the library with the main bundle or a mode in which a diagram keeps click handlers that call functions of the page.

Rejected:
- Loading the library with the main bundle: rejected because a page that shows no diagram would then fetch it anyway.
- A mode in which a diagram's text can carry click handlers: rejected because board text is written by agents.
