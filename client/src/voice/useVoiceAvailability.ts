import { useEffect, useState } from 'react';
import type { ForwardContext } from '../forwardApi';
import { getTemplateRealtimeConfig, getVoiceProxyCapability } from './voiceApi';

export type VoiceAvailability = { status: 'loading' | 'enabled' | 'disabled'; enabled: boolean; reason: string };
export function voiceAvailabilityFrom(enabled: boolean, proxyEnabled = true): VoiceAvailability {
  if (!proxyEnabled) return { status: 'disabled', enabled: false, reason: 'Voice 仅支持本地运行' };
  return enabled ? { status: 'enabled', enabled: true, reason: '' } : { status: 'disabled', enabled: false, reason: '当前 Template 未开启 Voice' };
}
export function useVoiceAvailability(ctx: ForwardContext | null, templateId: string): VoiceAvailability {
  const key = ctx && templateId ? `${ctx.environment}:${templateId}` : '';
  const [loaded, setLoaded] = useState<{ key: string; value: VoiceAvailability } | null>(null);
  useEffect(() => {
    let active = true;
    if (!ctx || !templateId) return () => { active = false; };
    void Promise.resolve().then(async () => {
      const proxyEnabled = await getVoiceProxyCapability();
      if (!active) return;
      if (!proxyEnabled) {
        setLoaded({ key, value: voiceAvailabilityFrom(false, false) });
        return;
      }
      const config = await getTemplateRealtimeConfig(ctx, templateId);
      if (active) setLoaded({ key, value: voiceAvailabilityFrom(config.enabled) });
    }).catch(() => { if (active) setLoaded({ key, value: { status: 'disabled', enabled: false, reason: 'Voice 配置不可用' } }); });
    return () => { active = false; };
  }, [ctx, key, templateId]);
  if (!key) return { status: 'disabled', enabled: false, reason: '请先选择 Template' };
  return loaded?.key === key ? loaded.value : { status: 'loading', enabled: false, reason: '正在检查 Voice 配置' };
}
