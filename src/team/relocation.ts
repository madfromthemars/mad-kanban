/**
 * Team servers a plugin may be moved to. A moved server answers with
 * { movedTo }, but the old one speaks plain HTTP, so anyone on the network
 * could fake that answer and collect tokens. Only follow moves to these.
 */
export const RELOCATION_TARGETS = ['https://kanban.onecatalog.dev'];

/** The allowed new server URL announced in a server response, or null. */
export function relocationTarget(json: unknown): string | null {
  const to = (json as { movedTo?: unknown } | null)?.movedTo;
  if (typeof to !== 'string') return null;
  const url = to.trim().replace(/\/+$/, '');
  return RELOCATION_TARGETS.includes(url) ? url : null;
}
