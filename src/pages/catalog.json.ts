/**
 * Static composition catalog at /catalog.json (built at site build time).
 * Agents should HTTP-fetch this URL rather than inventing package sets.
 */
import { compileCompositionCatalog } from '../data/compile-catalog';

export const prerender = true;

export async function GET(): Promise<Response> {
  const catalog = await compileCompositionCatalog();
  return new Response(JSON.stringify(catalog, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
