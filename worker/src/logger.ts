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
  const host = site?.trim() || 'us5.datadoghq.com';
  const url = `https://http-intake.logs.${host}/api/v2/logs`;
  const body = [
    {
      message: input.message,
      status: input.status,
      ddsource: 'pegma-dev',
      service: 'pegma-dev-api',
      ...(input.attributes === undefined ? {} : { ...input.attributes }),
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
