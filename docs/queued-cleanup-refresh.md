# Queued cleanup after a tooling update

Before dispatching a marked cleanup instruction, the existing inbox resolves
its currently configured cleanup capability. An unchanged capability keeps the
same queued item. A changed capability cancels only that exact unstarted
synthetic item and creates one deterministic successor using the shared cleanup
command renderer. The old text, marker, request receipts, original task pin,
accepted delivery, preparation and cleanup operation remain unchanged.

The transaction rechecks the queued row, raw marker, current owner and accepted
contract/binding, configured capability receipt, idle original family and pending
work. Its append-only supersession event links the old instruction/marker hashes
to the successor text, marker and capability hashes. Lost acknowledgments retry
without another successor. Ordinary instructions, started or uncertain cleanup,
pauses, changed acceptance and new work cannot be replaced by this transition.
A refusal leaves the item queued and allows unrelated sessions to progress.

The existing provider transition happens only when the current item is selected
by a later normal inbox pass. It preserves the same provider conversation and
runs outside the original checkout. The refresh itself creates no resource
cleanup authority and performs no provider or resource effects.

Disposable regression tests cover the old command failure, unchanged capability,
resolution-time drift, exact linked history, lost acknowledgment, real provider
continuation and an adopted external delivery with its original preparation and
operation. Live DRA-159 acceptance remains the original owner's continuation
after release; no live queued command was changed during implementation.
