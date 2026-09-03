The pane partitioning itself is sound, but using visible pane ranges changes legacy rendering for edge-overlapping tags. The new E2E also leaks browser contexts and can falsely pass before the relevant overlay frame is rendered.

Full review comments:

- [P2] Preserve tags that overlap the viewport edge — C:\repo\spreadjs\packages\render\src\overlay-layer.ts:172-172
  When the transform has little or no overscan, intersecting the active cell with `panes()` suppresses a tag whose cell is outside the visible index range even when the tag itself overlaps the clip. For example, with the unit dimensions, no frozen rows, and zero overscan, row 13 starts at y=310 but its tag starts at y=296 in a 300px viewport; the old `contentClip` renders the visible 4px, while this loop returns no piece. This violates the stated frozen=0/output-parity contract, so pane ownership must not discard drawing solely because the cell range is just outside the visible-cell range.

- [P2] Close the browser contexts created by this test — C:\repo\spreadjs\apps\playground\e2e\presence-frozen-panes.spec.ts:86-87
  When the full E2E suite runs, these contexts are created from the worker-scoped `browser` fixture and are never closed, so Alice and Bob remain connected to the shared WebSocket server and keep their pages/rAF loops alive through subsequent specs; an earlier assertion failure leaks them as well. Retain both returned contexts and close them in `finally`, as the other `openClient` tests do.

- [P2] Wait for Bob's overlay redraw before sampling pixels — C:\repo\spreadjs\apps\playground\e2e\presence-frozen-panes.spec.ts:131-132
  When Bob's `requestAnimationFrame` is delayed by background-page or CI throttling beyond 300ms, the snapshot can already contain Alice's new Presence while the overlay still shows the preceding empty fixed band. Because the assertion only checks for absence, it can then pass even with the original rendering bug. Wait on an observable overlay draw generation or otherwise force/confirm a render containing the received Presence instead of relying on a fixed sleep.

- [P3] Add the new review document to DOC-MAP — C:\repo\spreadjs\doc\DD\DD-041\codex-review-request.md:1-1
  If this untracked document is included in the change, `doc/DOC-MAP.md` remains unchanged, leaving the new document outside the repository's canonical documentation map. Update the map or omit the request artifact from the commit, as required by `AGENTS.md:52-55`.