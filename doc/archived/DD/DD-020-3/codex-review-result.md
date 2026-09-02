The patch has correctness failures around queued edits, synchronous rejection ordering, and standalone document replacement. These can produce incorrect Undo values, permanently disable Undo/Redo, or overwrite newly injected standalone data.

Full review comments:

- [P1] Capture the optimistic predecessor for queued edits — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:858-858
  When another edit is submitted before the previous local operation echoes, `committedDocument` excludes that preceding optimistic change. If both operations are then accepted in order, Undo of the second operation passes OCC but restores the value from before the first operation, skipping one user edit; this is especially reproducible during offline editing. Capture the pre-submit view/pending value, or serialize edits until ACK, while continuing to derive ownership revisions from server echoes.

- [P1] Bind compensation IDs before submission can reject — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:1082-1088
  When another client's change is already present locally before Ctrl+Z, `submitLocalOperation` synchronously rejects the stale compensation during `rebuildView` and invokes the observer before this call returns. Because the compensation ID is assigned only afterward, `onRejected` cannot match the limbo entry, reports the ordinary conflict code, and leaves Undo/Redo permanently busy. The ID must be associated before synchronous session events can fire, or early rejection events must be buffered.

- [P2] Register user operations before synchronous rejection — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:859-860
  If an edit becomes stale before commit, `submitLocalOperation` can synchronously emit `rejected` while rebuilding its optimistic view. At that point the operation has not yet been recorded, so `onRejected` removes nothing; the following call then records the already-rejected operation and also clears Redo, violating AC5. Registration must account for rejection events that occur before submission returns.

- [P1] Clear standalone history when replacing the document — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:128-128
  In standalone mode, `setData` replaces the entire authoritative document but this controller and its old patches remain alive. A later Ctrl+Z can therefore apply an operation from the previous document to matching row/column IDs in the replacement; because standalone `applyOperation` ignores `beforeRevision`, this can silently overwrite refreshed data, while removed IDs can instead throw. Reset the stacks and owned revisions whenever standalone data is replaced.

- [P2] Escape the NUL delimiter in the TypeScript source — C:\repo\spreadjs\packages\grid\src\undo-stack.ts:99-99
  This template literal contains a literal U+0000 byte, causing Git to classify the entire new TypeScript file as binary (`git diff --numstat` reports `- -`). Consequently normal source diffs and line-based reviews are hidden for this module. Use an escaped delimiter such as `\0`, or a non-binary key representation.