import './utils/env.js';
import type { VoiceEnvironment } from './voiceProxy.js';

export function voiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const allowedOrigins = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
    .filter((host): host is string => !!host).map(host => `https://${host}`);
  for (const value of (env.VOICE_ALLOWED_ORIGINS || '').split(',')) {
    if (!value.trim()) continue;
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.origin !== value.trim()) throw new Error('VOICE_ALLOWED_ORIGINS must contain exact HTTPS origins without paths');
    allowedOrigins.push(url.origin);
  }
  return {
    baseUrls: {
      'cn-prod': env.CN_PROD_FORWARD_API_BASE_URL?.trim() || 'https://api.qoder.com.cn/api/v1/forward',
      'global-prod': env.GLOBAL_PROD_FORWARD_API_BASE_URL?.trim() || 'https://api.qoder.com/api/v1/forward',
    } as Record<VoiceEnvironment, string>,
    allowedOrigins, allowLocal: !env.VERCEL,
    // Leave time for the closing handshake before the 300-second function limit.
    maxConnectionMs: env.VERCEL ? 280000 : undefined,
  };
}
