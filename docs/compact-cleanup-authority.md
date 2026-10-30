# Compact cleanup renewals

Large prepared inventories used to cross the control socket for every 32 files.
The original DRA-159 preparation was 10,194,756 bytes with 47,756 entries: roughly
15 GB per inventory pass before task projections and client parsing.

`POST /api/tasks/:taskId/cleanup-authority` accepts the stable `requestKey` and
the existing optional `finalizationVersion`. It runs the same full authority-only
validation as `prepare-finalization`, then returns only the task, primary, request,
preparation revision and cleanup operation revision/digest. It cannot create an
operation. Pause, revocation, resource changes and administration requirements
still fail through the original validation path.

The existing full response is unchanged for older clients. Deploy this server
before the client that uses the new route. A failed or unsupported compact
renewal stops the scan; it is never treated as success.

The matching Drafted client checks the complete returned identity against its
initial receipt. Source inventory walks renew at most every 512 entries or one
second between entries, and at completion. Every inventory entry is still
verified. Full resource checks and fresh authority before capture remain.

Validation includes the real control route, pause rejection and unchanged event
history; the client rejects every changed authority field before capture and
checks a real 1,024-file inventory for bounded renewals and changed saved bytes.
Original-task elapsed time remains a deployment acceptance check in DRA-213.
