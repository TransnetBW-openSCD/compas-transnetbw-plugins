import { Configuration, PluginsCustomResourcesApi } from '../generated';

export function createCustomResourceClient(
  baseUrl: string,
  fetchApi?: typeof fetch,
): PluginsCustomResourcesApi {
  return new PluginsCustomResourcesApi(
    new Configuration({
      basePath: baseUrl,
      fetchApi,
    })
  )
}
