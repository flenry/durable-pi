import type { SkillCatalogEntry } from "@sdk/api";

const catalogs = new Map<string, Promise<SkillCatalogEntry[]>>();

/** Fetch a device's catalog once, sharing in-flight requests and allowing failed requests to retry. */
export function getSkillCatalogForDevice(
  deviceId: string,
  load: () => Promise<SkillCatalogEntry[]>,
): Promise<SkillCatalogEntry[]> {
  const cached = catalogs.get(deviceId);
  if (cached) return cached;

  const request = Promise.resolve().then(load);
  catalogs.set(deviceId, request);
  void request.catch(() => {
    if (catalogs.get(deviceId) === request) catalogs.delete(deviceId);
  });
  return request;
}
