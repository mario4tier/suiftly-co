# TODO: add drift test for `STREAM_GRPC_PATH` / `UNARY_GRPC_PATH`

`apps/api/src/routes/grpc.ts` defines two gRPC paths used by the T-menu's
real-traffic injector:

- `STREAM_GRPC_PATH = '/sui.rpc.v2.SubscriptionService/SubscribeCheckpoints'`
- `UNARY_GRPC_PATH  = '/sui.rpc.v2.LedgerService/GetServiceInfo'`

These have hard requirements against **mhaxbe's** `STREAMING_GRPC_PATHS`
allowlist (in `scripts/utilities/cfg_mgr_haservice.py`):

- `STREAM_GRPC_PATH` **must be** in `STREAMING_GRPC_PATHS`, or the T-menu
  stream mode won't be retagged to `traffic_type=8` (double-counts bytes).
- `UNARY_GRPC_PATH` **must NOT be** in `STREAMING_GRPC_PATHS`, or the
  T-menu unary mode's close-logs get retagged and disappear from the UI.

mhaxbe's pytest suite has a drift test that pins `STREAMING_GRPC_PATHS`
against sui-proxy's `is_streaming_method` allowlist
(`scripts/test/pytest-haproxy-stream-meter-config.py` →
`test_streaming_paths_constant_matches_sui_proxy`). suiftly-co has no
equivalent test on its side — if someone changes either path in
`grpc.ts`, drift against mhaxbe's rule is undetected until T-menu traffic
either silently over-counts or disappears from charts.

To do: add a vitest unit test next to the grpc route (or under
`apps/api/tests/`) that reads the two constants and asserts:

- `STREAM_GRPC_PATH` starts with `/sui.rpc.v2.SubscriptionService/`
  (the service sui-proxy's is_streaming_method uses), and
- `UNARY_GRPC_PATH` does NOT start with that prefix (or more strictly,
  is on `LedgerService` / `MovePackageService` / `NameService` /
  `StateService` / etc., which are all unary services).

Optional stretch: if the two repos ever share a manifest (JSON, codegen
from sui-proxy `.proto`), use that instead of a string-prefix check.

Scope:
- One new test file under `apps/api/tests/` (or `packages/shared/tests/`)
- No code changes to `grpc.ts`.
- Test must fail if someone edits the two constants to drift from the
  mhaxbe invariant.
