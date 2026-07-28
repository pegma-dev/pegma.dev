import type { Logger } from '@pegma/spine';
import { createTeeLogger } from '@pegma/logger-tee';
import { createCloudflareLogger } from '@pegma/logger-cloudflare';
import {
  createDatadogLogger,
  type DatadogSubmitInput,
} from '@pegma/logger-datadog';

export interface LoggerEnv {
  /** Datadog API key for HTTP log intake. Optional — Cloudflare arm still runs. */
  DATADOG_API_KEY?: string;
  /** Datadog site host, e.g. us5.datadoghq.com. Defaults to us5 (this org). */
  DATADOG_SITE?: string;
}

/**
 * Composition root: Spine Logger → Cloudflare Workers Logs + Datadog.
 * Matches the pegma.dev dual-sink plan in logger-adapters.
 */
export function createAppLogger(
  env: LoggerEnv,
  waitUntil: (promise: Promise<unknown>) => void,
): Logger {
  const cloudflare = createCloudflareLogger();

  const datadog = createDatadogLogger((input) => {
    const apiKey = env.DATADOG_API_KEY;
    if (!apiKey) {
      return;
    }
    waitUntil(shipDatadogLog(apiKey, env.DATADOG_SITE, input));
  });

  return createTeeLogger(cloudflare, datadog);
}

async function shipDatadogLog(
  apiKey: string,
  site: string | undefined,
  input: DatadogSubmitInput,
): Promise<void> {
  const host = datadogIntakeHost(site);
  const url = `https://http-intake.logs.${host}/api/v2/logs`;
  const body = [
    {
      // Caller attributes first; fixed identity fields win on collision.
      ...(input.attributes === undefined ? {} : { ...input.attributes }),
      message: input.message,
      status: input.status,
      ddsource: 'pegma-dev',
      service: 'pegma-dev-api',
    },
  ];

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Fail-soft: observability must not take down the request.
  }
}

/** Bare site host for intake URLs; strips scheme/path from copy-paste mistakes. */
function datadogIntakeHost(site: string | undefined): string {
  const raw = site?.trim() || 'us5.datadoghq.com';
  try {
    const withScheme = raw.includes('://') ? raw : `https://${raw}`;
    const hostname = new URL(withScheme).hostname;
    return hostname || 'us5.datadoghq.com';
  } catch {
    return 'us5.datadoghq.com';
  }
}
