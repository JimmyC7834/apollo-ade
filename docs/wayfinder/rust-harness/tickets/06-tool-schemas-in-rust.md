---
label: wayfinder:research
title: How tools are declared and validated in Rust
parent: ../map.md
blocked-by: []
assignee:
status: open
---

# How tools are declared and validated in Rust

## Question

pi declares tool schemas in **TypeBox** and validates *and coerces* arguments in-process
before dispatch (`pi/packages/ai/src/utils/validation.ts:278`). Coercion matters more
than it sounds: models emit `"5"` where the schema says number, and a harness that
rejects instead of coercing burns a turn every time.

Rust has no TypeBox. Establish what the equivalent is, and whether the obvious answer
(`serde` + `schemars` derive) actually covers the ground:

- **Schema generation.** Does `schemars` emit JSON Schema the Messages API accepts
  as-is, or does it need post-processing (`$ref` flattening, `additionalProperties`,
  unsupported keywords)?
- **Coercion.** `serde` is strict by default. What does lenient-but-safe look like, and
  is it worth it?
- **Error shape.** A validation failure has to become a `tool_result` the model can
  recover from, not a Rust panic or an opaque string.
- **Dynamism.** Profiles select tool *subsets* per session, and the schema list is sent
  on every request — so the tool set is runtime data, not a compile-time constant.
  Confirm the derive approach survives that.
- **The registry shape.** A trait object per tool vs. an enum. The enum is cheaper and
  closes the set; extensions (deferred, but coming) will want it open.

Deliverable: a markdown summary in `docs/` naming the crates, with the failure modes
found, linked back from this ticket.
