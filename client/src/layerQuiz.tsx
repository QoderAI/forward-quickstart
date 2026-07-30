import { memo, useCallback, useEffect, useMemo, useState } from 'react';

// 层级选型问卷 —— 登录页右上角入口弹出。
// 问卷内容与《QCA-Forward层vs-Managed层选型问卷.md》保持一致：
// 8 题，每题两个主选项（A 偏 Forward / B 偏 Managed）+ 一个"说不准"兜底出口。
// 判定规则：
//   - Q2/Q3/Q6 选 A 为硬判定，直接推荐 Forward（这三项能力 Forward 独有）；
//   - Q1 选 B 时跳过 Q2/Q3（自动按 B 记，因为没有具体使用者）；
//   - "说不准"（U）不计入任何一边，但会进入结果页的「待确认清单」；
//     关键题选 U 时额外标注——它的答案可能直接改变结论；
//   - 跳过过半时结论降级为「Forward 起步」并标注置信度偏低
//     （官方选型指引的安全默认也是从 Forward 开始）。

const FORWARD_DOC_URL = 'https://docs.qoder.com/zh/cloud-agents/api/forward/overview';
const MANAGED_DOC_URL = 'https://docs.qoder.com/zh/cloud-agents/api/agents/list';

interface QuizQuestion {
  id: string;
  /** 顶部小标签 */
  tag: string;
  /** 结果页「待确认清单」里的短标题 */
  shortLabel: string;
  title: string;
  hint?: string;
  optionA: { label: string; desc: string };
  optionB: { label: string; desc: string };
  /** 选 A 直接锁定 Forward */
  hardStopOnA?: boolean;
  /** 命中硬判定时展示的理由 */
  hardStopReason?: string;
  /** "说不准"选项的补充说明（因题而异，帮助用户判断该找谁确认） */
  unsureNote?: string;
}

const QUESTIONS: QuizQuestion[] = [
  {
    id: 'q1',
    tag: '用户',
    shortLabel: 'AI 提供给谁用',
    title: '你想把 AI 提供给谁用？',
    optionA: { label: '给终端用户使用', desc: '我们的客户、会员或全体员工，每个人都会跟它对话' },
    optionB: { label: '给系统内部用', desc: '它在后台干活，普通用户看不到它' },
    unsureNote: '两种都有，或还没想清楚',
  },
  {
    id: 'q2',
    tag: '专属空间',
    shortLabel: '是否需要用户专属空间',
    title: '每个使用者需要有自己的专属空间吗？',
    hint: '比如：张三和李四的聊天记录、AI 对他们的了解，必须分开、互不可见。',
    optionA: { label: '需要', desc: '专属空间涵盖个人 Skill、MCP、文件——调用 Agent 时只需传入用户 ID，平台按身份把对应专属空间自动提供给 Agent' },
    optionB: { label: '不需要身份概念', desc: '每次调用 Agent 时，由开发者自主指定本次任务的 Agent 配置及挂载资源' },
    hardStopOnA: true,
    hardStopReason: '「用户专属空间」只有 Forward 层内建，自己开发成本很高',
    unsureNote: '建议和产品负责人确认',
  },
  {
    id: 'q3',
    tag: 'IM 接入',
    shortLabel: '是否要接入微信 / 钉钉 / 飞书',
    title: '使用者会在微信、企业微信、钉钉、飞书里直接跟它聊天吗？',
    optionA: { label: '会', desc: '最好扫个码就能接入，不用开发' },
    optionB: { label: '不会', desc: '或者我们已经有自己的接入方案' },
    hardStopOnA: true,
    hardStopReason: '「微信 / 钉钉 / 飞书扫码接入」只有 Forward 层提供',
    unsureNote: '建议和业务/ 运营团队确认',
  },
  {
    id: 'q4',
    tag: '能力设定',
    shortLabel: 'AI 能力如何设定',
    title: 'AI 助手的"人设和能力"是怎么定的？',
    hint: '说话风格、会做什么。',
    optionA: { label: '提前统一设好', desc: '管理员配置一次，大家拿来就用；偶尔给个别用户开小灶' },
    optionB: { label: '每次干活前临时定', desc: '不同任务由程序动态给它配不同的能力和资料' },
    unsureNote: '建议和技术负责人确认',
  },
  {
    id: 'q5',
    tag: '日常维护',
    shortLabel: '上线后由谁维护',
    title: '上线之后，日常维护 AI 的人是谁？',
    hint: '改话术、加资料、调权限。',
    optionA: { label: '运营 / 客服 / 业务人员', desc: '他们不会写代码，最好在管理界面上点点就能改' },
    optionB: { label: '工程师', desc: '改配置就是改代码、走发布流程，我们习惯这样' },
    unsureNote: '还没定分工',
  },
  {
    id: 'q6',
    tag: '批量任务',
    shortLabel: '是否需要批量跑任务',
    title: '需要一次性提交一大批任务让 AI 慢慢跑完吗？',
    hint: '比如：一晚上处理一万条客户资料，第二天下载结果。',
    optionA: { label: '需要', desc: '批量提交，跑完统一取结果' },
    optionB: { label: '不需要', desc: '都是即问即答' },
    hardStopOnA: true,
    hardStopReason: '「批量任务」是 Forward 层独有能力',
    unsureNote: '建议确认业务里有没有批处理场景',
  },
  {
    id: 'q7',
    tag: '团队',
    shortLabel: '技术团队投入能力',
    title: '你们的技术团队情况更接近哪种？',
    optionA: { label: '人手有限', desc: '现成功能越多越好，能不开发就不开发' },
    optionB: { label: '技术很强', desc: '就想要最底层的能力，上层全部自己搭，控制力优先' },
    unsureNote: '还没评估投入',
  },
  {
    id: 'q8',
    tag: '阶段',
    shortLabel: '项目所处阶段',
    title: '这个 AI 项目现在处于什么阶段？',
    optionA: { label: '验证期', desc: '先跑起来看效果，行不行几周内要有答案' },
    optionB: { label: '建设期', desc: '方向已定，这是要长期投入的核心系统，前期多花时间打地基没关系' },
    unsureNote: '还没立项 / 阶段未定',
  },
];

/** A = 偏 Forward，B = 偏 Managed，U = 说不准（不计分） */
type Answer = 'A' | 'B' | 'U';

const DECISIVE_IDS = QUESTIONS.filter((q) => q.hardStopOnA).map((q) => q.id);

interface QuizResult {
  layer: 'forward' | 'managed' | 'forward-first';
  hardStopReason?: string;
  countA: number;
  countB: number;
  /** 用户选了"说不准"的题（用于结果页待确认清单） */
  unsure: QuizQuestion[];
  /** 说不准的题里包含关键题，或跳过过半 → 结论置信度偏低 */
  lowConfidence: boolean;
}

function computeResult(answers: Record<string, Answer>, hardStopReason?: string): QuizResult {
  const values = Object.values(answers);
  const countA = values.filter((a) => a === 'A').length;
  const countB = values.filter((a) => a === 'B').length;
  const unsure = QUESTIONS.filter((q) => answers[q.id] === 'U');
  const hasDecisiveUnsure = unsure.some((q) => DECISIVE_IDS.includes(q.id));
  // 跳过过半，或关键题未定 → 结论仅供参考
  const lowConfidence = unsure.length * 2 >= QUESTIONS.length || hasDecisiveUnsure;

  // 硬判定优先：命中即为确定结论（不受置信度影响）
  if (hardStopReason) {
    return { layer: 'forward', hardStopReason, countA, countB, unsure, lowConfidence: false };
  }
  // 信息不足（跳过过半）时不下强结论，走安全默认：Forward 起步
  if (unsure.length * 2 >= QUESTIONS.length) {
    return { layer: 'forward-first', countA, countB, unsure, lowConfidence };
  }
  if (countA > countB) return { layer: 'forward', countA, countB, unsure, lowConfidence };
  if (countB > countA) return { layer: 'managed', countA, countB, unsure, lowConfidence };
  return { layer: 'forward-first', countA, countB, unsure, lowConfidence };
}

/** 结果页的推荐文案 */
const RESULT_META = {
  forward: {
    name: 'Forward 层',
    tagline: '拎包入住 · 快速交付',
    color: '#34D399',
    glow: 'rgba(52,211,153,0.35)',
    points: ['用户专属空间和记忆，平台自动隔离', '微信 / 企微 / 钉钉 / 飞书扫码接入', '定时任务 + 批量任务开箱即用', '业务人员在界面上就能日常维护'],
    docUrl: FORWARD_DOC_URL,
    docLabel: '查看 Forward API 文档',
  },
  managed: {
    name: 'Managed 层',
    tagline: '毛坯自建 · 完全掌控',
    color: '#FBBF24',
    glow: 'rgba(251,191,36,0.35)',
    points: ['最底层的 Agent 运行能力，自由度最高', '每次调用动态决定能力与资料', '精细的版本管理与并发控制', '适合自建产品层的强技术团队'],
    docUrl: MANAGED_DOC_URL,
    docLabel: '查看 Managed API 文档',
  },
  'forward-first': {
    name: 'Forward 层起步',
    tagline: '先快后深 · 平滑演进',
    color: '#60A5FA',
    glow: 'rgba(96,165,250,0.35)',
    points: ['两边倾向接近，建议先用 Forward 快速上线', '上线快、踩坑少，先见到业务效果', '之后有深度需求随时补上 Managed', '两层可以同时用，资源互通'],
    docUrl: FORWARD_DOC_URL,
    docLabel: '查看 Forward API 文档',
  },
} as const;

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-1 rounded-full transition-all duration-500 ${
            i < current ? 'w-5 bg-[#5B8CFF]' : i === current ? 'w-8 bg-gradient-to-r from-[#5B8CFF] to-[#8B5CF6] shadow-[0_0_8px_rgba(91,140,255,0.8)]' : 'w-5 bg-white/12'
          }`}
        />
      ))}
    </div>
  );
}

export const LayerQuizButton = memo(function LayerQuizButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative flex items-center gap-2 overflow-hidden rounded-full border border-[#3550FF]/25 bg-white/80 px-4 py-2 text-[13px] font-medium text-[#3550FF] shadow-[0_2px_12px_rgba(53,80,255,0.10)] backdrop-blur transition hover:border-[#3550FF]/50 hover:shadow-[0_4px_20px_rgba(53,80,255,0.22)]"
      >
        <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-[#3550FF]/10 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
        </svg>
        选型助手
      </button>
      {open && <LayerQuizModal onClose={() => setOpen(false)} />}
    </>
  );
});

/**
 * 独立路由页（/quiz）：同一份问卷组件以整页形态渲染，方便直接把
 * 链接发给别人填写——深色底全屏居中，无遮罩、无关闭按钮。
 */
export function LayerQuizPage() {
  return <LayerQuizModal standalone />;
}

function LayerQuizModal({ onClose, standalone = false }: { onClose?: () => void; standalone?: boolean }) {
  // trail: 实际展示过的题目下标序列（跳题时也能正确回退）
  const [trail, setTrail] = useState<number[]>([0]);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [picked, setPicked] = useState<Answer | null>(null);
  const [phase, setPhase] = useState<'quiz' | 'reveal' | 'result'>('quiz');
  const [result, setResult] = useState<QuizResult | null>(null);
  const [animKey, setAnimKey] = useState(0);

  const currentIndex = trail[trail.length - 1];
  const question = QUESTIONS[currentIndex];
  const answeredCount = trail.length - 1;

  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const finish = useCallback((finalAnswers: Record<string, Answer>, hardStopReason?: string) => {
    setResult(computeResult(finalAnswers, hardStopReason));
    setPhase('reveal');
    window.setTimeout(() => setPhase('result'), 1400);
  }, []);

  const pick = useCallback((answer: Answer) => {
    if (picked) return; // 动画播放期间忽略重复点击
    setPicked(answer);

    const next = { ...answers, [question.id]: answer };

    window.setTimeout(() => {
      setPicked(null);
      // 硬判定：Q2/Q3/Q6 选 A 直接出结果（"说不准"不触发）
      if (answer === 'A' && question.hardStopOnA) {
        finish(next, question.hardStopReason);
        return;
      }
      let nextIndex = currentIndex + 1;
      // Q1 选 B：跳过 Q2/Q3（没有具体使用者，自动按 B 记）
      if (question.id === 'q1' && answer === 'B') {
        next.q2 = 'B';
        next.q3 = 'B';
        nextIndex = QUESTIONS.findIndex((q) => q.id === 'q4');
      }
      setAnswers(next);
      if (nextIndex >= QUESTIONS.length) {
        finish(next);
        return;
      }
      setTrail((prev) => [...prev, nextIndex]);
      setAnimKey((k) => k + 1);
    }, 350);
  }, [answers, currentIndex, finish, picked, question]);

  const goBack = useCallback(() => {
    if (trail.length <= 1) return;
    const prevTrail = trail.slice(0, -1);
    const backTo = QUESTIONS[prevTrail[prevTrail.length - 1]];
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[question.id];
      delete next[backTo.id];
      // 回到 Q1 时清掉跳题自动记的 Q2/Q3
      if (backTo.id === 'q1') { delete next.q2; delete next.q3; }
      return next;
    });
    setTrail(prevTrail);
    setAnimKey((k) => k + 1);
  }, [question.id, trail]);

  const restart = useCallback(() => {
    setTrail([0]);
    setAnswers({});
    setPicked(null);
    setResult(null);
    setPhase('quiz');
    setAnimKey((k) => k + 1);
  }, []);

  const meta = result ? RESULT_META[result.layer] : null;
  const ratio = useMemo(() => {
    if (!result) return 0.5;
    const total = result.countA + result.countB;
    return total === 0 ? 0.5 : result.countA / total;
  }, [result]);

  return (
    <div className={standalone ? 'flex min-h-screen items-center justify-center bg-[#05070F] p-4' : 'fixed inset-0 z-[200] flex items-center justify-center p-4'}>
      {!standalone && <div className="absolute inset-0 bg-[#05070F]/72 backdrop-blur-[6px]" onClick={onClose} />}

      <div className="relative max-h-[92vh] w-full max-w-[560px] overflow-y-auto overflow-x-hidden rounded-3xl border border-white/10 bg-[#0B0F1E] shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
        {/* 背景装饰：网格 + 光晕 */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.22]"
          style={{
            backgroundImage: 'linear-gradient(rgba(91,140,255,0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(91,140,255,0.16) 1px, transparent 1px)',
            backgroundSize: '36px 36px',
            maskImage: 'radial-gradient(ellipse 90% 70% at 50% 0%, black 30%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse 90% 70% at 50% 0%, black 30%, transparent 75%)',
          }}
        />
        <div
          className="pointer-events-none absolute -top-28 left-1/2 h-56 w-[130%] -translate-x-1/2 rounded-full blur-3xl transition-colors duration-1000"
          style={{ background: phase === 'result' && meta ? meta.glow : 'rgba(53,80,255,0.30)' }}
        />

        {!standalone && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-white/40 transition hover:bg-white/8 hover:text-white/80"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        )}

        <div className="relative px-8 pb-8 pt-7">
          {/* ─── 头部 ─── */}
          <div className="mb-6 flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-[#5B8CFF] to-[#8B5CF6] shadow-[0_0_18px_rgba(91,140,255,0.5)]">
              <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
              </svg>
            </span>
            <div>
              <div className="text-[15px] font-semibold text-white">选型助手</div>
              <div className="text-[11px] text-white/40">Forward 层还是 Managed 层？答几个问题就知道</div>
            </div>
          </div>

          {/* ─── 问答阶段 ─── */}
          {phase === 'quiz' && (
            <div key={animKey} className="animate-quiz-in">
              <div className="mb-5 flex items-center justify-between">
                <StepDots total={QUESTIONS.length} current={currentIndex} />
                <span className="font-mono text-[11px] tracking-wider text-white/35">
                  {String(answeredCount + 1).padStart(2, '0')} / {String(QUESTIONS.length).padStart(2, '0')}
                </span>
              </div>

              <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-[#5B8CFF]/30 bg-[#5B8CFF]/10 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-[#8FB3FF]">
                {question.tag}
                {question.hardStopOnA && <span className="text-[#34D399]">· 关键题</span>}
              </div>
              <h3 className="text-[19px] font-semibold leading-snug text-white">{question.title}</h3>
              {question.hint && <p className="mt-1.5 text-[12.5px] leading-5 text-white/45">{question.hint}</p>}

              <div className="mt-5 flex flex-col gap-3">
                {(['A', 'B'] as const).map((key) => {
                  const opt = key === 'A' ? question.optionA : question.optionB;
                  const isPicked = picked === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => pick(key)}
                      className={`group relative overflow-hidden rounded-2xl border p-4 text-left transition-all duration-300 ${
                        isPicked
                          ? 'border-[#5B8CFF] bg-[#5B8CFF]/15 shadow-[0_0_28px_rgba(91,140,255,0.35)]'
                          : picked
                            ? 'border-white/8 bg-white/[0.03] opacity-40'
                            : 'border-white/10 bg-white/[0.04] hover:border-[#5B8CFF]/50 hover:bg-[#5B8CFF]/8 hover:shadow-[0_0_20px_rgba(91,140,255,0.15)]'
                      }`}
                    >
                      <div className="flex items-start gap-3.5">
                        <span
                          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-[13px] font-bold transition-all duration-300 ${
                            isPicked ? 'bg-[#5B8CFF] text-white shadow-[0_0_12px_rgba(91,140,255,0.8)]' : 'bg-white/8 text-white/50 group-hover:bg-[#5B8CFF]/25 group-hover:text-[#AFC8FF]'
                          }`}
                        >
                          {key}
                        </span>
                        <span className="min-w-0">
                          <span className={`block text-[14.5px] font-semibold transition-colors ${isPicked ? 'text-white' : 'text-white/85'}`}>{opt.label}</span>
                          <span className="mt-0.5 block text-[12.5px] leading-5 text-white/45">{opt.desc}</span>
                        </span>
                        {isPicked && (
                          <svg className="ml-auto mt-1 h-5 w-5 shrink-0 text-[#5B8CFF]" fill="currentColor" viewBox="0 0 24 24">
                            <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25Zm4.28 7.28a.75.75 0 0 0-1.06-1.06l-4.72 4.72-1.72-1.72a.75.75 0 1 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.06 0l5.25-5.25Z" clipRule="evenodd" />
                          </svg>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* "说不准"兜底出口：视觉权重刻意低于两个主选项，避免成为偷懒默认项 */}
              <button
                type="button"
                onClick={() => pick('U')}
                className={`mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed py-2.5 text-[12.5px] transition ${
                  picked === 'U'
                    ? 'border-[#8B5CF6]/60 bg-[#8B5CF6]/12 text-[#C4B0FF]'
                    : picked
                      ? 'border-white/8 text-white/20'
                      : 'border-white/12 text-white/35 hover:border-white/25 hover:bg-white/[0.03] hover:text-white/60'
                }`}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
                </svg>
                说不准 / 都行
                {question.unsureNote && <span className="text-white/25">· {question.unsureNote}</span>}
              </button>

              <div className="mt-4 flex h-5 items-center justify-between">
                {trail.length > 1 ? (
                  <button type="button" onClick={goBack} className="flex items-center gap-1 text-[12px] text-white/35 transition hover:text-white/70">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" /></svg>
                    上一题
                  </button>
                ) : <span />}
                <span className="text-[11px] text-white/25">选择后自动进入下一题</span>
              </div>
            </div>
          )}

          {/* ─── 计算揭晓过渡 ─── */}
          {phase === 'reveal' && (
            <div className="flex flex-col items-center py-14 animate-quiz-in">
              <div className="relative h-16 w-16">
                <span className="absolute inset-0 animate-spin rounded-full border-2 border-[#5B8CFF]/15 border-t-[#5B8CFF]" style={{ animationDuration: '0.9s' }} />
                <span className="absolute inset-2 animate-spin rounded-full border-2 border-[#8B5CF6]/15 border-b-[#8B5CF6]" style={{ animationDuration: '1.3s', animationDirection: 'reverse' }} />
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="h-2 w-2 rounded-full bg-[#5B8CFF] shadow-[0_0_12px_rgba(91,140,255,1)] animate-pulse" />
                </span>
              </div>
              <div className="mt-6 font-mono text-[12px] tracking-[0.25em] text-white/50">ANALYZING</div>
              <div className="mt-1.5 text-[13px] text-white/35">正在根据你的回答匹配最合适的接入层…</div>
            </div>
          )}

          {/* ─── 结果阶段 ─── */}
          {phase === 'result' && result && meta && (
            <div className="animate-quiz-in">
              <div className="mb-1 text-center font-mono text-[11px] tracking-[0.3em] text-white/35">
                {result.lowConfidence ? 'SUGGESTION' : 'RECOMMENDATION'}
              </div>
              <div className="text-center">
                <span
                  className="inline-block bg-gradient-to-r bg-clip-text text-[30px] font-bold text-transparent"
                  style={{ backgroundImage: `linear-gradient(120deg, #FFFFFF 20%, ${meta.color} 80%)` }}
                >
                  {meta.name}
                </span>
                <div className="mt-0.5 text-[13px] font-medium" style={{ color: meta.color }}>{meta.tagline}</div>
              </div>

              {/* 倾向强度条 */}
              <div className="mx-auto mt-5 max-w-[380px]">
                <div className="flex justify-between text-[10.5px] font-medium tracking-wide">
                  <span className="text-[#34D399]">Forward 倾向 {result.countA}</span>
                  {result.unsure.length > 0 && <span className="text-white/30">说不准 {result.unsure.length}</span>}
                  <span className="text-[#FBBF24]">Managed 倾向 {result.countB}</span>
                </div>
                <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-white/8">
                  <div className="rounded-l-full bg-gradient-to-r from-[#34D399] to-[#5B8CFF] transition-all duration-1000" style={{ width: `${ratio * 100}%` }} />
                  <div className="flex-1 rounded-r-full bg-gradient-to-r from-[#5B8CFF]/40 to-[#FBBF24]/70" />
                </div>
                {result.hardStopReason && (
                  <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#34D399]/25 bg-[#34D399]/8 px-3 py-2.5 text-[12px] leading-5 text-[#8EE7C5]">
                    <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clipRule="evenodd" /></svg>
                    命中关键需求：{result.hardStopReason}
                  </div>
                )}
                {result.lowConfidence && !result.hardStopReason && (
                  <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#8B5CF6]/25 bg-[#8B5CF6]/8 px-3 py-2.5 text-[12px] leading-5 text-[#C4B0FF]">
                    <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" /></svg>
                    有几题还没定，这个结论仅供参考。确认下面的问题后可以再测一次。
                  </div>
                )}
              </div>

              {/* 推荐理由 */}
              <div className="mt-5 grid grid-cols-2 gap-2">
                {meta.points.map((point, i) => (
                  <div
                    key={i}
                    className="animate-quiz-in rounded-xl border border-white/8 bg-white/[0.04] px-3 py-2.5 text-[12px] leading-5 text-white/65"
                    style={{ animationDelay: `${i * 90}ms`, animationFillMode: 'backwards' }}
                  >
                    <span className="mr-1.5" style={{ color: meta.color }}>◆</span>
                    {point}
                  </div>
                ))}
              </div>

              {/* 待确认清单：把"说不准"转成可执行的行动项 */}
              {result.unsure.length > 0 && (
                <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-white/70">
                    <svg className="h-3.5 w-3.5 text-[#8B5CF6]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25Z" /></svg>
                    还需要和团队确认这 {result.unsure.length} 件事
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {result.unsure.map((q) => {
                      const decisive = DECISIVE_IDS.includes(q.id);
                      return (
                        <div key={q.id} className="flex items-start gap-2 text-[12px] leading-5">
                          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${decisive ? 'bg-[#34D399]' : 'bg-white/25'}`} />
                          <span className="text-white/60">{q.shortLabel}</span>
                          {decisive && (
                            <span className="shrink-0 rounded-md bg-[#34D399]/12 px-1.5 py-0.5 text-[10.5px] font-medium text-[#8EE7C5]">
                              可能直接改变结论
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {result.layer === 'forward-first' && !result.lowConfidence && (
                <p className="mt-3 text-center text-[11.5px] text-white/35">你的回答两边倾向接近——两层可以同时用、资源互通，先用 Forward 见效最快。</p>
              )}

              <div className="mt-6 flex items-center gap-3">
                <a
                  href={meta.docUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#3550FF] to-[#7C4DFF] py-3 text-[14px] font-semibold text-white shadow-[0_8px_28px_rgba(53,80,255,0.4)] transition hover:shadow-[0_8px_36px_rgba(53,80,255,0.6)]"
                >
                  {meta.docLabel}
                  <svg className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" /></svg>
                </a>
                <button
                  type="button"
                  onClick={restart}
                  className="flex items-center gap-1.5 rounded-xl border border-white/12 px-4 py-3 text-[13px] text-white/55 transition hover:border-white/25 hover:text-white/85"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                  重新测
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
