要修正: deferred setActiveCell can commit input to the previous cell, and range deletion violates the read-only-column skip contract. Date-boundary corruption and unstable React remount keys add further correctness regressions.

Full review comments:

- [P1] Block input until deferred active-cell movement completes — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:389-389
  `insertRows()` followed by `setActiveCell(newRowId, ...)` queues the movement until the next RAF, but the textarea remains focused on the old cell. If an input event arrives before that RAF—reproducible by dispatching input in the same task—the old cell is edited and committed when the queue drains, matching the one observed wrong-cell commit. Prevent editor input while a `setActiveCell` command is pending, or provide synchronous/completion-aware activation before accepting input (`doc/DD/DD-035/contract.md:66-67`).

- [P2] Allow range Delete from a read-only anchor — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:2351-2353
  When a selection starts in a read-only column and extends into an editable column, pressing Delete returns here before `decideNavigationIntercept` can issue `delete-range`; therefore nothing is cleared. For example, select read-only B, Shift+Left to include editable A, then Delete: A incorrectly remains unchanged, although the range contract requires skipping only B and applying the clear to A (`doc/DD/DD-035/contract.md:45`). Apply this suppression only without an explicit range, or process range Delete first.

- [P2] Preserve four-digit LocalDate boundaries — C:\repo\spreadjs\packages\grid\src\date-editor.ts:56-58
  `Date.UTC` treats years 0–99 as 1900–1999, so moving from accepted values such as `0000-01-01` jumps to 1900; moving past `9999-12-31` produces `10000-01-01`, which is no longer the contracted four-digit LocalDate and is committed as a string rather than `kind:'date'`. Use year-safe calendar arithmetic and clamp or reject movement beyond the supported four-digit range (`doc/DD/DD-035/contract.md:23-24`).

- [P2] Canonicalize schema props before building the mount key — C:\repo\spreadjs\packages\react\src\index.ts:174-179
  Plain `JSON.stringify` is sensitive to object insertion order, so semantically identical records such as `{a: ..., b: ...}` and `{b: ..., a: ...}` generate different keys and destroy/remount the grid, dropping an active draft and reconnecting collaboration unexpectedly. `readOnlyColumns` ordering has the same issue although it is treated as a set. Canonicalize unordered records/sets while preserving order-sensitive arrays such as select options (`doc/DD/DD-035/contract.md:88-90`).