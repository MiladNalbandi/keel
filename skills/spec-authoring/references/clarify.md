# Clarifying, before the criteria exist

Adapted from `ai-coding-toolkit:clarify-loop` and bundled here so phase 1 does not depend on that
plugin being installed. Where both are present they agree; this one is scoped to a keel feature,
which already decides some of what that skill has to ask — the stack, the test commands, the gate
mode and the review lenses are in `.keel/config.yml` from init, so do not ask them again.

Run this **before** writing the spec. Its output is what the criteria get written from.

---

## The five questions

If you cannot answer one from the interview, that is the next question to ask — not a gap to fill
in on the user's behalf.

| Question | What it prevents |
|---|---|
| What exactly is being built? | scope creep, and building the wrong thing |
| Where does it live? | an architectural misfit that review catches late |
| What pattern does it follow? | a second way of doing something that already has one |
| What must not break? | regressions nobody thought to test |
| How will we know it is done? | **this one becomes the acceptance criteria** |

---

## The identity probe — ask it before writing any criteria

**Trigger on any of:** `user`, `users`, `auth`, `login`, `register`, `sign in`, `sign up`,
`account`, `member`, `role`, `permission`.

This is the highest-value question in the interview, because the three readings differ by an order
of magnitude in scope and all three are called "users":

| | What it means | Scope |
|---|---|---|
| **A · Named entity** | a table with name and email. Records are linked to it. No session, no token, no password | **small** — a foreign key, a create endpoint, maybe a list |
| **B · Authentication** | people log in, get a token or session, and identity gates what they see | **large** — password storage, token lifecycle, auth middleware, protected routes |
| **C · Authorization** | authentication already exists; this is who may do what — roles, ownership, permission rules | **medium** — no login flow, guards on existing routes |

Ask which, and if they are unsure: *"describe what a user should be able to do that they cannot do
today."* That question separates the three better than the labels do.

Then **write the answer into the spec** — "user means B here" — because the next person to read it
will otherwise assume whichever one their last project used.

**If the answer is B**, stop and say so. Authentication is a design decision with real
alternatives, not a criterion to write: it wants its own spec, and often its own feature.

---

## Per task type

A keel feature is usually the first block, but a `/keel:fix` or a performance change borrows from
the others.

**New feature** — what is being built, in one sentence · which module · which existing file it
should mirror · what must be true when it is done, each item listed · what must not change.

**Bug fix** — what is observed versus expected · the smallest reproduction · when it last worked ·
what else touches that path. *Do not ask for a theory of the cause; that is the investigator's job
and an early theory anchors it.*

**Performance** — what is slow, measured, not felt · the number it must reach · the input size it
holds at · what may be traded for it.

**Refactor** — what shape it should end in · what behaviour must not change (this is the whole
constraint) · what proves that, and whether those tests exist yet.

**Integration** — whose API · what happens when it is down, slow, or returns something undocumented
· where the credentials live · whether a sandbox exists to test against.

---

## Stop and clarify — do not proceed

- You are guessing what the user wants rather than asking
- The work touches more than three modules
- You cannot tell which of two existing patterns to follow
- The requirements contain *later*, *eventually*, or *maybe*
- It changes a public interface, or **a database schema** — which has its own section in phase 1,
  with the sizing questions that decide the migration strategy

Each of these is cheaper to resolve now than in RED, and much cheaper than at ship.

---

## Record what a constraint will cost, next to the constraint

When the user rules something out — a pattern they do not want, a check they say is not needed, an
abstraction they would rather not have — and you can see it will show in the code, **write the cost
in the spec beside the exclusion.** *"No shared error mapper — the 500 branch is then duplicated in
each controller and none of it is reachable by a test."*

Not to argue. They said no and no stays no. But a constraint recorded without its cost becomes
invisible the moment it reaches the code: the implementation looks deliberate, nobody remembers the
trade, and the person who made it never finds out what it bought. Written down once, it is a
decision the reviewer at ship can see; left unwritten, it is an omission nobody can audit.

This is the same rule GREEN applies while writing and `keel:ac-reviewer` applies at the gate. It
belongs here too, because the spec is where the constraint is first stated and the cheapest place
to say what it means.
