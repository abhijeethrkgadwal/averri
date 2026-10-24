# Governance

Averri is a community open-source project. This file says how
decisions get made while the project is small, and how that changes
as it grows.

## Now: a single maintainer, specs as the constitution

- The maintainer (see MAINTAINERS.md) merges pull requests and cuts
  releases.
- The documents in `docs/SPEC-*.md` are normative. Behaviour that
  disagrees with a spec is a bug. Behaviour a spec does not cover is
  undefined and open to proposal.
- A change to behaviour starts with a change to the spec. Open a pull
  request that edits the spec and, if accepted, the implementation
  follows. Each accepted deviation or rejection is logged in
  `docs/SPEC-DECISIONS.md` with a number and a reason.
- Anyone can open a Discussion to propose a direction, including one
  that contradicts the current design. The research record in
  `docs/research/` exists so that proposals can argue with evidence.

## Later: co-maintainers

When two or more people have each landed several non-trivial
contributions, the maintainer will invite them as co-maintainers.
Co-maintainers can merge, and spec changes then need agreement from
two maintainers. This file is updated when that happens.

## What does not change

- The license is Apache-2.0 and will not be changed to a source-
  available or copyleft license. There is no contributor license
  agreement; contributions are accepted under the Developer
  Certificate of Origin (`git commit -s`).
- There is no telemetry and no hosted service in this repository.
- The benchmark (`docs/BENCHMARK.md`) is pre-registered, and results
  are published whether they favour Averri or not.
