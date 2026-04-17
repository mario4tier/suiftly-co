import { TRPCError } from '@trpc/server';
import { isServiceAvailable, type ServiceType } from '@suiftly/shared/constants';

/**
 * Enum covers ALL SERVICE_TYPE values so clients always get a useful zod
 * error for truly unknown strings, but reserved-but-gated services (ssfn,
 * sealo) short-circuit here with a clear "not yet available" response
 * rather than a generic failure.
 */
export function assertServiceAvailable(serviceType: ServiceType): void {
  if (!isServiceAvailable(serviceType)) {
    throw new TRPCError({
      code: 'NOT_IMPLEMENTED',
      message: `Service '${serviceType}' is reserved but not yet available.`,
    });
  }
}
