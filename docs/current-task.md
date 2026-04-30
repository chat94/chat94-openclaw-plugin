# Current Task: Protocol Alignment Follow-Up

**Status**: Completed for protocol + operator workflow pass
**Updated**: 2026-04-16
**Context**: The plugin now matches the updated protocol direction where the plugin bootstraps the first key, stores it outside normal channel config, and exposes operator-facing OpenClaw CLI workflows for setup/pairing.

## Completed

### Protocol and Model Changes

- `pairKey` / `pairId` internal model migrated to `groupKey` / `groupId`
- relay `hello` now sends `group_id`
- account resolution now prefers plugin-managed key files, while still accepting env/config legacy overrides
- only `CHAT4000_GROUP_KEY` is supported for env-based key injection

### Pairing Support

- pairing room id derivation implemented with the current protocol namespace
- pairing message payload types added
- initiator-side pairing workflow implemented in `src/pairing.ts`
- joiner-side pairing workflow implemented in `src/pairing.ts`
- exact proof generation implemented with required `0x00` separators
- X25519 wrapped-key flow implemented
- plugin-managed durable key storage implemented in `src/key-store.ts`
- OpenClaw CLI registration implemented in `src/cli.ts`

### Tests and Verification

- unit tests updated for group-key protocol behavior
- new unit coverage added for:
  - group-id derivation
  - pairing code normalization
  - pairing room id derivation
  - proof generation
  - wrapped-key roundtrip
- build verified with `npm run build`
- unit suite verified with `npm test`

## Remaining Gaps

These are still open after the operator workflow pass:

1. Full host-side inbound dispatch in `src/channel.ts`
2. Host-side streaming/status callback wiring
3. Setup-entry / setup-wizard integration if a native channel wizard is desired later
4. Contract test execution against a real relay binary in this workspace

## Notes

- The code is aligned to the current protocol file, including the latest pairing room namespace change.
- Operator-facing commands now target:
  - `openclaw chat4000 setup`
  - `openclaw chat4000 pair`
  - `openclaw chat4000 setup --no-pair`
  - `openclaw chat4000 status`
- Contract tests still depend on an external relay binary and were not rerun as part of this workspace-only pass.
