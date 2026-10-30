# Comment delivery

Ordinary comments are conversation input. An @mention does not grant authority
or create a separate delivery path. Registered threads and managed source/child
issues retain their existing owner. A new, unowned thread enters the semantic
router only when a configured comment workflow permits it. No eligible owner or
an ambiguous owner produces an in-thread explanation rather than a new task.

## Policy and mechanisms

Machine config owns connections, credentials and author/repository subscriptions.
The repository's committed `.remote-agent.config.json` (or its configured external
tooling revision) binds events to delivery and chooses reaction presentation:

```json
{
  "workflows": {
    "comments": { "on": "comment.created", "deliver": "queue-session" },
    "steer": {
      "on": "comment.reaction",
      "when": [{ "reaction.emoji": ["compass"] }],
      "deliver": "steer-session"
    }
  },
  "conversationReactions": {
    "queued": "hourglass_flowing_sand",
    "processing": "eyes",
    "replied": "speech_balloon",
    "attention": "warning",
    "failed": "x"
  }
}
```

These deliveries carry the original input; they do not compose a new skill or
start a session. Issue workflows retain their skill and
`start-session`/`message-session` contract. Comment workflows reuse the same
condition matcher and existing comment dispatcher/shared inbox. Steering requires
an explicit reaction condition and the configured owner acting on their own
comment. Unicode and the listed standard shortcodes are interchangeable.

No comment workflow or reaction mapping is added to an existing repository by
default. Existing managed-owner and registered-thread continuations remain
available. Existing issue workflows are unchanged. Legacy `agentHandle` values
remain readable for config compatibility but have no trigger semantics; the
connection's `agentUserId` still prevents self-authored loops.

Remote Agent owns validated routing, durable origin/turn correlation, queueing,
deduplication, reply receipts and lifecycle projection. Integration adapters own
Linear reads/writes; the generic runtime does not interpret emoji. ACP transports
execution and lifecycle identity. The desktop edits these schema fields using
the existing explicit save/revert draft.

## Reactions

- ⏳ means durably queued for the owning primary.
- 👀 appears only after prompt submission starts (or confirmed native steering).
- 💬 means the conversational answer was confirmed published in its original
  thread. Completing a turn does not imply a reply or task completion.
- ⚠️ means routing, an uncertain result or delivery needs attention.
- ❌ means a confirmed handling/delivery failure.

Queue and active reactions are removed as their state ends. Reply receipts can
coexist with an active marker when an explicit reply precedes turn completion.
Only the configured automation identity's managed reactions are removed; human
reactions, including the owner's steering request, are preserved. A projection
failure stays pending and is retried independently of agent execution.

## Reply provenance

`RuntimeSourceMessage` records immutable integration/connection/resource/comment
identity and the root thread, plus the selected primary and execution request.
`RuntimeInstruction` references it. Turn binding occurs in the durable claim
before the provider can execute tools; a metadata journal preserves old attempt
identity so a late result cannot fall through to another conversation.

The prompt supplies an opaque `sourceMessageId`. `read_reply_context` returns
the original parent Markdown (including evidence references). `reply_to_source`
requires that ID, a stable request key and answer content. The server verifies
the source ID against its current executing turn; stale tools cannot silently
reply to a newer comment. Agents never choose an arbitrary destination issue or
thread. Child ownership is revalidated before publication.

A durable reply UUID reconciles a lost Linear response. The automatic reply uses
the same outbox and preserves a pending or published explicit answer regardless
of differences in final prose. `publish_issue_update` remains a separate,
intentional task progress/review update. Workflow turns without a comment origin
retain their existing checkpoint behavior.

## Steering capability

The owner's configured control reaction requests steering; it is not a receipt
that steering happened. `RuntimeMessageControl` survives out-of-order webhooks
and atomically promotes the same queued instruction through the optional native
runtime capability. Successful promotion prevents a later duplicate queued turn.
The control records the canonical comment revision at ingress; delayed edit
webhooks and retries cannot substitute another revision's instruction.
Idle races use the original normal instruction; already-handled input is not
injected again. Interrupted sends become unknown and are never blindly replayed.

Installed acpx 0.13.2 exposes `mode: steer` but its runtime manager does not
implement native active-turn steering. This adapter therefore reports
unsupported, preserves the queued instruction and posts a separate explanation
in its source thread. It does not cancel the active turn, launch another writer
or pretend a serialized follow-up was a native steer. Enabling actual steering
requires a verified upstream/runtime capability and live acceptance.

Release preparation rechecked upstream acpx v0.21.1: its
[prompting contract](https://github.com/openclaw/acpx/blob/v0.21.1/docs/prompting.md#steer-turns)
still queues steer turns. The
[native-extension proposal](https://github.com/openclaw/acpx/issues/836)
remains open. An adapter advertising a steering extension alone is insufficient:
the transport must target the existing turn and reject an idle race without
starting detached work. Until that public runtime contract exists, upgrading
acpx does not provide a supported native-steering remedy. Queued comments and
pending controls also remain subject to the task owner's pause.

## Rollout

Apply the additive Prisma migration before starting the updated server. Generate
the config schemas and explicitly commit any desired repository policy changes;
do not alter running tasks' historical tooling pins. A server restart is needed.
Existing worktrees, session identities and transcripts remain intact. Source
tests/builds and a deployed live Linear/native-runtime acceptance run are separate
verification stages.

For the deployment coordinator:

1. Integrate this publisher after the existing Remote Agent cleanup/recovery
   release. Use the supported updater's stopped-service migration and database
   snapshot/rollback flow. The migration `20261029190000_comment_delivery` adds
   two nullable instruction columns and the source-message/control tables; it
   does not rewrite existing tasks or sessions.
2. Deploy and verify the server before selecting policy containing the new
   comment event/delivery values. Older server schemas cannot read those values.
3. In the owning repository or committed external tooling policy, add the
   `comments`/`steer` workflows and reaction mapping shown above. Unconfigured
   repositories receive no reaction mapping automatically. Select the reviewed
   policy revision through the existing configuration mechanism and coordinate
   its server restart. Preserve historical task/tooling pins.
4. Verify real signed ingress and same-thread publication on the deployed host,
   including a second comment waiting behind active work and an owner pause.
   Confirm the deployed revision, additive migration, session identity and
   outbox receipts. The isolated real-Linear/Claude test establishes the ordinary
   path but does not replace deployed ingress/restart acceptance.
5. Verify that the configured steering request explains the unsupported
   capability and preserves the original queue. Keep native steering acceptance
   unresolved until it actually reaches the target turn through a supported
   capability; a queued follow-up is not that evidence.
