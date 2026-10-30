# Retain inactive test sockets during source cleanup

DRA-187 extends the existing prepared source inventory with an exact `socket`
entry. It does not add a `/tmp` exemption or change task ownership. The socket
must be inside the existing owner-authenticated source/owned-path scope, belong
to the current user, and have exactly one filesystem link. The frozen entry
records device, inode, mode, uid, gid, size, link count and nanosecond modification
and change times.

Both server preparation/confirmation and Drafted's prepared cleanup independently
check the entry. They require `ECONNREFUSED` from both AF_UNIX STREAM and DGRAM
connections to the same inode. A successful connection, wrong-protocol error,
permission error, disappearance, timeout or any uncertain result blocks cleanup.
A bound STREAM socket that has not called `listen()` therefore remains active for
this purpose. No payload is sent and no socket is unlinked.

The probe runs in a bounded Bun child with only the exact open parent-directory
descriptor inherited as fd 3. Ancestors are opened without following symlinks.
The child changes its own working directory using `fchdir` and connects to the
basename, so a retained quarantine pathname longer than `sockaddr_un` still works.
Directory and socket identities are checked around the probes. Every exceptional
path terminates and reaps the owned child. Existing process and open-file checks
remain additional requirements; an empty `lsof` result alone never proves that a
socket is inactive. Unsupported platforms and unavailable native APIs fail closed.

The existing exclusive whole-root rename preserves the socket with the source,
evidence and browser state. Confirmation checks the retained inventory and absent
original paths. A replaced socket or ancestor fails verification, including after
capture; neither the original nor substituted material is deleted. Retries use
the same recorded quarantine and journal.

## Kernel basis

- [Apple XNU `unp_connect`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c)
  rejects an unbound socket vnode with `ECONNREFUSED`. For a bound endpoint, its
  type comparison occurs before the STREAM listening check; the cross-protocol
  probe detects the bound-but-not-listening case.
- [Linux v6.12 `unix_find_bsd`](https://github.com/torvalds/linux/blob/v6.12/net/unix/af_unix.c#L1054-L1095)
  looks up the endpoint by filesystem inode, reports refusal when none is bound,
  and reports `EPROTOTYPE` for a bound endpoint of another type.
- [Bun extra stdio descriptors](https://bun.sh/reference/bun/Spawn/BaseOptions/stdio)
  provide the inherited directory handle. No absolute socket pathname is passed
  to `connect` and the server's working directory never changes.

## Disposable verification

The native matrix runs real STREAM and DGRAM socket fixtures on Darwin and Linux
(Bun 1.3.14, Linux `oven/bun:1.3.14`). It covers stale sockets, bound but
non-listening STREAM, live listeners, live DGRAM, long retained paths, leaf and
ancestor substitutions, symlinks, changed owner proofs, unsupported FIFOs and
input failure after probe-child creation. The input-failure test verifies the
child has been reaped before observation returns.

Server inventory tests preserve all eight resource identities, reject live
sockets even with an injected quiet process/open-file observer, and check
confirmation/replay against the same retained socket inode. Drafted tests perform
the actual native capture, inject lost resource acknowledgements and substitute a
socket at the final capture window. The existing cross-repository finalizer tests
now retain STREAM and DGRAM sockets through real server preparation, client
capture, both lost-Done cases, server confirmation and close-last.

Regular-file and journal readers also open with `O_NONBLOCK` before checking file
type. Bounded child regressions show a FIFO replacement cannot hang these readers.

This evidence uses disposable fixtures only. DRA-159 still requires deployment
of both reviewed changes and retry by its original primary against its current
ownership and acceptance records. This change does not perform that retry or
resolve the separate evidence-upload restriction.

The integrated server typecheck, 725-test suite (3,276 assertions) and desktop
build passed on released main `41f0399`. The final native observer matrix passed
12 tests/41 assertions separately on both Darwin and Linux, including the
additional deadline regression. The actual cross-repository suite passed 15
cases/162 assertions; the integrated full suite also ran these cases against the
matching Drafted checkout. Logs are `/private/tmp/dra187-server-full.log`,
`/private/tmp/dra187-server-build.log`, `/private/tmp/dra187-cross-integration.log`,
`/private/tmp/dra187-darwin-observer-final.log`, and
`/private/tmp/dra187-linux-observer-final.log`.
