import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { VoiceSessionView } from './VoiceSessionView';

const mocks = vi.hoisted(() => ({
  voice: {} as Record<string, unknown>,
}));

vi.mock('./useVoiceSession', () => ({
  useVoiceSession: () => mocks.voice,
}));

const props = {
  ctx: { environment: 'cn-prod', pat: 'pat' } as never,
  identityId: 'identity-1',
  templateId: 'template-1',
  templateName: '测试模板',
  selectedVoice: 'longanqian' as const,
  initialConversationId: null,
  autoStart: false,
  launchKey: 1,
  onConversationCreated: vi.fn(),
  onStartFailed: vi.fn(),
};

beforeEach(() => {
  Object.assign(mocks.voice, {
    conversationId: 'conv-1',
    effectiveVoice: 'longanlingxin',
    historyWarning: null,
    stage: 'listening',
    timeline: [],
    muted: false,
    speakerMuted: false,
    setSpeakerMuted: vi.fn(),
    error: null,
    microphoneWarning: null,
    sendText: vi.fn(() => true),
    setMuted: vi.fn(),
    end: vi.fn(),
    continueConversation: vi.fn(),
  });
});

describe('VoiceSessionView work timeline', () => {
  test('keeps active work open while collapsing tool input and output independently', () => {
    mocks.voice.timeline = [{
      kind: 'work',
      id: 'work-1',
      workId: 'work-1',
      objective: '下载并分析 SDK',
      status: 'running',
      steps: [
        { kind: 'tool_use', title: 'Bash', detail: '{"command":"git clone repo"}' },
        { kind: 'tool_result', title: 'Bash', detail: 'fatal: authentication failed', isError: true },
      ],
    }];

    const html = renderToStaticMarkup(<VoiceSessionView {...props} />);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('任务处理中');
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).not.toContain('<details open');
    expect(html).toContain('调用');
    expect(html).toContain('入参');
    expect(html).toContain('结果');
    expect(html).toContain('出参');
  });

  test('collapses completed work and omits its verbose body until expanded', () => {
    mocks.voice.timeline = [{
      kind: 'work',
      id: 'work-2',
      workId: 'work-2',
      objective: '整理结果',
      status: 'completed',
      steps: [{ kind: 'tool_result', title: 'Bash', detail: 'very verbose raw output' }],
      result: '任务完成',
    }];

    const html = renderToStaticMarkup(<VoiceSessionView {...props} />);

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('已完成');
    expect(html).not.toContain('very verbose raw output');
    expect(html).not.toContain('任务完成');
  });
});

describe('VoiceSessionView call controls', () => {
  test('uses an icon-only microphone control with an explicit action label', () => {
    const html = renderToStaticMarkup(<VoiceSessionView {...props} />);

    expect(html).toContain('aria-label="将麦克风静音"');
    expect(html).toContain('<svg');
    expect(html).toContain('aria-label="将扬声器静音"');
    expect(html).toContain('aria-label="结束连接"');
    expect(html.indexOf('将扬声器静音')).toBeLessThan(html.indexOf('将麦克风静音'));
    expect(html).not.toContain('>麦<');
  });

  test('describes the inverse action while muted', () => {
    mocks.voice.muted = true;

    const html = renderToStaticMarkup(<VoiceSessionView {...props} />);

    expect(html).toContain('aria-label="取消麦克风静音"');
    expect(html).not.toContain('>静<');
  });
});

describe('VoiceSessionView voice configuration', () => {
  test('shows the confirmed voice without a duplicate new conversation action', () => {
    const html = renderToStaticMarkup(<VoiceSessionView {...props} />);
    expect(html).toContain('音色：龙安灵心');
    expect(html).not.toContain('换音色 / 新对话');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('新对话音色');
  });
  test('does not assume a selected voice for unconnected history', () => {
    mocks.voice.effectiveVoice = null;
    mocks.voice.stage = 'ended';
    const html = renderToStaticMarkup(<VoiceSessionView {...props} />);
    expect(html).toContain('待连接确认');
    expect(html).toContain('继续语音对话');
  });
});
