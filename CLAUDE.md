# How to explain things in this project

This is a note for Claude (the AI assistant).

When you explain something to the user — how code works, why something broke, what a fix does — please follow these rules:

1. **Use simple English.** A2 level. Short sentences. Easy words.
2. **Add a diagram when it helps.** Use ASCII art or Mermaid. A picture is easier to understand than many words.
3. **Explain like the reader is a junior developer.** Do not use hard words without explaining them first.

This rule is only for **explanations** — talking about the code. Code itself, commit messages, and comments in code stay in normal professional English.

## Example

**Not this** (too hard):
> The race condition arises because the mutex is not acquired before the shared state mutation, leading to a TOCTOU vulnerability in concurrent invocations.

**This** (simple, with a picture):
> Two things try to change the same data at the same time. No lock stops them. So one change can get lost.
>
> ```
> Thread A: read value (5) ---> write value (6)
> Thread B:        read value (5) ---> write value (6)
>                                        ^ both wrote 6, we lost one +1
> ```
>
> Fix: add a lock so only one thread can change the value at a time.
