import { useEffect, useState } from 'react';
import type { ForwardContext } from '../forwardApi';
import { getVoiceProxyCapability } from './voiceApi';

export type VoiceAvailability = { status: 'loading' | 'enabled' | 'disabled'; enabled: boolean; reason: string };
export function voiceAvailabilityFrom(proxyEnabled: boolean): VoiceAvailability {
  return proxyEnabled
    ? { status: 'enabled', enabled: true, reason: '' }
    : { status: 'disabled', enabled: false, reason: '当前部署未启用语音代理' };
}
export function useVoiceAvailability(ctx: ForwardContext | null, templateId: string, identityId: string): VoiceAvailability {
  const [capability, setCapability] = useState<VoiceAvailability | null>(null);
  useEffect(() => {
    let active = true;
    void getVoiceProxyCapability().then((enabled) => {
      if (active) setCapability(voiceAvailabilityFrom(enabled));
    }).catch(() => {
      if (active) setCapability({ status: 'disabled', enabled: false, reason: '语音代理不可用' });
    });
    return () => { active = false; };
  }, []);
  if (!ctx) return { status: 'disabled', enabled: false, reason: '请先登录' };
  if (!templateId) return { status: 'disabled', enabled: false, reason: '请先选择 Template' };
  if (!identityId) return { status: 'disabled', enabled: false, reason: '正在准备 Identity' };
  return capability ?? { status: 'loading', enabled: false, reason: '正在检查语音代理' };
}
