export type ChannelBindingMode = 'qr' | 'manual';

export function channelBindingModes(capabilities: {
  qrSupport: boolean;
  manualSupport: boolean;
}): ChannelBindingMode[] {
  const modes: ChannelBindingMode[] = [];
  if (capabilities.qrSupport) modes.push('qr');
  if (capabilities.manualSupport) modes.push('manual');
  return modes;
}
