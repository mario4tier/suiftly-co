# TODO: dedupe gRPC constants between `apps/api/src` and `apps/api/tests`

The same gRPC client-side constants are duplicated in two places:

- `apps/api/src/routes/grpc.ts`
  - `STREAM_GRPC_PATH = '/sui.rpc.v2.SubscriptionService/SubscribeCheckpoints'`
  - `EMPTY_GRPC_FRAME = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00])`
  - `GRPC_HEADERS(...)` with `:path`, `:method`, `content-type: application/grpc`, `te: trailers`
- `apps/api/tests/helpers/grpc-requests.ts`
  - Inline literal `/sui.rpc.v2.SubscriptionService/SubscribeCheckpoints`
  - `emptyGrpcFrame = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00])`
  - Inline `te: 'trailers'` + header duplication

Both reference the same gRPC wire contract and can drift silently.

To do: hoist these into a shared module — e.g. `packages/shared/src/grpc/` or
`apps/api/src/lib/grpc-constants.ts` — and import from both the route and the
test helper. Keeping the route and test helpers on the exact same constants
also makes it easier to keep the streaming path list synchronized with
mhaxbe's `STREAMING_GRPC_PATHS` (see the separate cross-repo drift TODO).

Scope:
- Create shared module with `STREAM_GRPC_PATH`, `UNARY_GRPC_PATH` (currently
  only in `apps/api/src/routes/grpc.ts`), `EMPTY_GRPC_FRAME`, `gRPC_HEADERS`.
- Update `apps/api/src/routes/grpc.ts` to import.
- Update `apps/api/tests/helpers/grpc-requests.ts` to import.
- Run `npx vitest` + relevant Playwright specs to confirm nothing regressed.
