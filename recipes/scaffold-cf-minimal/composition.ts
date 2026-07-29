/**
 * Recipe / scaffold: scaffold-cf-minimal
 *
 * Synthetic starter: “Glass Wing” — a fictional static museum site Worker
 * with an explicit composition root. Empty-ish on purpose: agents modify
 * this skeleton instead of inventing composition from scratch.
 *
 * Known-good pins (align with catalog.json / recipe packages):
 *   @pegma/spine@0.1.1
 *
 * Optional health: host may add @pegma/health later; this fixture does not
 * import it so the catalog package list (spine only) stays honest.
 *
 * Not a branded product clone. No accounts, storage, or mail unless the
 * agent deliberately adds them from the catalog.
 */

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
  /**
   * When true, expose a minimal host-owned liveness handler that does **not**
   * depend on @pegma/health — teaches the composition-root shape only.
   * For production probes, prefer composing @pegma/health at the host.
   */
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

  return {
    clock,
    logger,
    withHealth: true,
    health: async () => {
      // Minimal host-owned probe — not @pegma/health. Agents that want
      // composable probes should install and wire @pegma/health from the catalog.
      return {
        status: 200,
        body: {
          service: GLASS_WING.service,
          status: 'ok',
          scaffold: true,
          site: GLASS_WING.siteOrigin,
          now: clock.now(),
        },
      };
    },
  };
}
