/**
 * Recipe / scaffold: scaffold-cf-minimal
 *
 * Synthetic starter: “Glass Wing” — a fictional static museum site Worker
 * with an explicit composition root and optional public health probe.
 * Empty-ish on purpose: agents modify this skeleton instead of inventing
 * composition from scratch.
 *
 * Known-good pins (align with catalog.json at scaffold time):
 *   @pegma/spine@0.1.1
 *   @pegma/health@0.1.1
 *
 * Not a branded product clone. No accounts, storage, or mail unless the
 * agent deliberately adds them from the catalog.
 */

import {
  createDetailCheck,
  createProcessCheck,
  runHealthChecks,
  toHealthResponse,
  type HealthResult,
} from '@pegma/health';
import {
  systemClock,
  type Clock,
  type Logger,
} from '@pegma/spine';

/** Fictional museum static site. */
export const GLASS_WING = {
  service: 'glass-wing-site',
  siteOrigin: 'https://glasswing.example',
} as const;

export interface GlassWingCompositionOptions {
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** When true, include a process health check only (no storage ping). */
  readonly withHealth?: boolean;
}

export interface GlassWingComposition {
  readonly clock: Clock;
  readonly logger: Logger | undefined;
  readonly withHealth: boolean;
  /**
   * Optional liveness handler. Present only when `withHealth` is true.
   * Host wires this to GET /health (or equivalent).
   */
  readonly health?: () => Promise<{
    readonly status: number;
    readonly body: unknown;
  }>;
}

const silentLogger: Logger = {
  log() {
    /* scaffold: host replaces Logger at the composition root */
  },
};

/**
 * Explicit composition root for a minimal Cloudflare-shaped Worker host.
 * Wire packages here — do not autodiscover.
 */
export function createGlassWingComposition(
  options: GlassWingCompositionOptions = {},
): GlassWingComposition {
  const clock = options.clock ?? systemClock;
  const logger = options.logger;
  const withHealth = options.withHealth === true;

  if (!withHealth) {
    return { clock, logger, withHealth: false };
  }

  const healthLogger = logger ?? silentLogger;

  return {
    clock,
    logger,
    withHealth: true,
    health: async () => {
      const result: HealthResult = await runHealthChecks({
        service: GLASS_WING.service,
        logger: healthLogger,
        checks: [
          createProcessCheck(),
          createDetailCheck('scaffold', {
            synthetic: true,
            site: GLASS_WING.siteOrigin,
          }),
        ],
      });
      const { status, body } = toHealthResponse(result);
      return { status, body };
    },
  };
}
