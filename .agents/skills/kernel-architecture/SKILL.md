---
name: kernel-architecture
description: How the efferent kernel's parts compose — replace a plugin, wrap one with a higher-order plugin, react to an event, or record a fact in the journal; no hooks, registries, priorities or config wiring. Read before adding or changing a kernel contract, a stock kernel plugin, the loop or memory, or before proposing a new way for plugins to extend each other.
---

# Change the kernel's architecture

The decision is `docs/adr/0001-kernel-plugin-composition.md`. Read it before you design.
This skill is the checklist; the record has the reasons.

## Choose the way

1. A method of a contract sees the value at the right moment, with the session in hand:
   **wrap** that contract with a higher-order plugin.
2. The moment sits between two calls inside the loop: **replace** the loop. Keep its
   pieces exported; when two loops copy the same block, make it a contract.
3. Nobody needs an answer back: listen to an **event** with `Core.on`.
4. Other parts must see it later: append an entry to the **journal** through the open
   session.

## When you wrap

- [ ] The wrapper is a function from a plugin of the contract to a plugin of the same
      contract, hiding the inner one with `Layer.provide`. Never a plain layer placed in
      a `provideMerge` chain: one composed on the wrong line wraps nothing.
- [ ] Each contract's stack is its plugin with its wrappers applied; the rest of the agent
      gets one layer per contract.
- [ ] You know where it must sit: the last applied is the outermost and runs first. A
      memory wrapper's entry lands in the journal before those of the wrappers inside it.
      A wrapper that must sit at a fixed place says so in its doc comment.
- [ ] A memory wrapper appends its entry first, then delegates, and never edits the
      request the memory below returns.
- [ ] Nothing that must be recorded happens in a model wrapper: it has no session.
- [ ] A test shows the part using the contract sees the wrapped one, and the order.

## Do not add

A hook mechanism, a registry of steps, priorities or phase numbers on wrappers, optional
contracts a part uses when present, a config object that wires plugins, a store beside the
journal, or listeners that write to the journal. If a need seems to require one, check
"What would reopen this" in the record. If it applies, write a new record that supersedes
0001 before any code.
