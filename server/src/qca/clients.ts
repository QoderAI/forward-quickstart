import { ForwardClient, ManagedClient, type ClientOptions } from 'qca-sdk';

export type ApiLayer = 'forward' | 'cloud';
export type ApiEnvironment = 'cn-prod' | 'global-prod';

export function apiBaseUrls(layer: ApiLayer): Record<ApiEnvironment, string> {
  const suffix = layer === 'forward' ? 'FORWARD' : 'CLOUD';
  return {
    'cn-prod': (process.env[`CN_PROD_${suffix}_API_BASE_URL`]?.trim() || `https://api.qoder.com.cn/api/v1/${layer}`).replace(/\/+$/, ''),
    'global-prod': (process.env[`GLOBAL_PROD_${suffix}_API_BASE_URL`]?.trim() || `https://api.qoder.com/api/v1/${layer}`).replace(/\/+$/, ''),
  };
}

export function clientOptions(baseURL: string, token: string, authMode: unknown): ClientOptions {
  // Static tokens belong to this request/connection, never to a shared client.
  return {
    baseURL, maxRetries: 0, timeout: 30_000,
    ...(authMode === 'service-account' ? { authMode: 'sa', accessToken: token } : { authMode: 'pat', pat: token }),
  };
}

export function createTokenIssuer(baseURL: string) {
  // Key authentication is supplied to the resource method for this call only.
  return new ForwardClient({ baseURL, maxRetries: 0, timeout: 30_000 });
}

export function createClient(layer: 'forward', baseURL: string, token: string, authMode: unknown): ForwardClient;
export function createClient(layer: 'cloud', baseURL: string, token: string, authMode: unknown): ManagedClient;
export function createClient(layer: ApiLayer, baseURL: string, token: string, authMode: unknown): ForwardClient | ManagedClient;
export function createClient(layer: ApiLayer, baseURL: string, token: string, authMode: unknown) {
  const options = clientOptions(baseURL, token, authMode);
  return layer === 'forward' ? new ForwardClient(options) : new ManagedClient(options);
}
