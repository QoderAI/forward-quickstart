// Matches Cloud Agents Web VoiceTab controls without a private icon-package dependency.
const iconPaths = {
  "speaker": "M6.60282 10.0001L10 7.22056V16.7796L6.60282 14.0001H3V10.0001H6.60282ZM2 16.0001H5.88889L11.1834 20.3319C11.2727 20.405 11.3846 20.4449 11.5 20.4449C11.7761 20.4449 12 20.2211 12 19.9449V4.05519C12 3.93977 11.9601 3.8279 11.887 3.73857C11.7121 3.52485 11.3971 3.49335 11.1834 3.66821L5.88889 8.00007H2C1.44772 8.00007 1 8.44778 1 9.00007V15.0001C1 15.5524 1.44772 16.0001 2 16.0001ZM23 12C23 15.292 21.5539 18.2463 19.2622 20.2622L17.8445 18.8444C19.7758 17.1937 21 14.7398 21 12C21 9.26016 19.7758 6.80629 17.8445 5.15557L19.2622 3.73779C21.5539 5.75368 23 8.70795 23 12ZM18 12C18 10.0883 17.106 8.38548 15.7133 7.28673L14.2842 8.71584C15.3213 9.43855 16 10.64 16 12C16 13.36 15.3213 14.5614 14.2842 15.2841L15.7133 16.7132C17.106 15.6145 18 13.9116 18 12Z",
  "speakerMuted": "M10 7.22056L6.60282 10.0001H3V14.0001H6.60282L10 16.7796V7.22056ZM5.88889 16.0001H2C1.44772 16.0001 1 15.5524 1 15.0001V9.00007C1 8.44778 1.44772 8.00007 2 8.00007H5.88889L11.1834 3.66821C11.3971 3.49335 11.7121 3.52485 11.887 3.73857C11.9601 3.8279 12 3.93977 12 4.05519V19.9449C12 20.2211 11.7761 20.4449 11.5 20.4449C11.3846 20.4449 11.2727 20.405 11.1834 20.3319L5.88889 16.0001ZM20.4142 12.0001L23.9497 15.5356L22.5355 16.9498L19 13.4143L15.4645 16.9498L14.0503 15.5356L17.5858 12.0001L14.0503 8.46454L15.4645 7.05032L19 10.5859L22.5355 7.05032L23.9497 8.46454L20.4142 12.0001Z",
  "microphone": "M11.9998 3C10.3429 3 8.99976 4.34315 8.99976 6V10C8.99976 11.6569 10.3429 13 11.9998 13C13.6566 13 14.9998 11.6569 14.9998 10V6C14.9998 4.34315 13.6566 3 11.9998 3ZM11.9998 1C14.7612 1 16.9998 3.23858 16.9998 6V10C16.9998 12.7614 14.7612 15 11.9998 15C9.23833 15 6.99976 12.7614 6.99976 10V6C6.99976 3.23858 9.23833 1 11.9998 1ZM3.05469 11H5.07065C5.55588 14.3923 8.47329 17 11.9998 17C15.5262 17 18.4436 14.3923 18.9289 11H20.9448C20.4837 15.1716 17.1714 18.4839 12.9998 18.9451V23H10.9998V18.9451C6.82814 18.4839 3.51584 15.1716 3.05469 11Z",
  "microphoneMuted": "M16.4249 17.839L21.1925 22.6066L22.6068 21.1924L2.80777 1.3934L1.39355 2.80761L7.00016 8.41421V10C7.00016 12.7614 9.23873 15 12.0002 15C12.4825 15 12.9489 14.9317 13.3902 14.8042L14.9404 16.3544C14.0464 16.7688 13.0503 17 12.0002 17C8.47368 17 5.55627 14.3923 5.07105 11H3.05509C3.51623 15.1716 6.82854 18.4839 11.0002 18.9451V23H13.0002V18.9451C14.2341 18.8087 15.3929 18.4228 16.4249 17.839ZM11.5528 12.9669C10.2541 12.7727 9.22745 11.7461 9.03328 10.4473L11.5528 12.9669ZM19.3747 15.1604L17.9323 13.7179C18.4407 12.9084 18.788 11.9874 18.9293 11H20.9452C20.7754 12.5366 20.2187 13.9565 19.3747 15.1604ZM16.4658 12.2514L14.9173 10.703C14.9715 10.4775 15.0002 10.2421 15.0002 10V6C15.0002 4.34315 13.657 3 12.0002 3C10.7059 3 9.6031 3.81956 9.18237 4.96802L7.68575 3.47139C8.55427 1.99268 10.1613 1 12.0002 1C14.7616 1 17.0002 3.23858 17.0002 6V10C17.0002 10.8099 16.8076 11.5748 16.4658 12.2514Z",
  "stop": "M6 5H18C18.5523 5 19 5.44772 19 6V18C19 18.5523 18.5523 19 18 19H6C5.44772 19 5 18.5523 5 18V6C5 5.44772 5.44772 5 6 5Z"
};

function ControlIcon({ name, size = 20 }: { name: keyof typeof iconPaths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

const muteButtonClass = (muted: boolean) => `grid h-10 w-10 place-items-center rounded-full border text-[#141414] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3550FF] ${muted ? 'border-[#DDDDDD] bg-[#EFEFEF] hover:bg-[#EFEFEF]' : 'border-[#E6E6E6] bg-white hover:bg-[#EFEFEF]'}`;

export function VoiceCallControls({ muted, speakerMuted, onMutedChange, onSpeakerMutedChange, onEnd }: {
  muted: boolean;
  speakerMuted: boolean;
  onMutedChange: (muted: boolean) => void;
  onSpeakerMutedChange: (muted: boolean) => void;
  onEnd: () => void;
}) {
  const microphoneLabel = muted ? '取消麦克风静音' : '将麦克风静音';
  const speakerLabel = speakerMuted ? '取消扬声器静音' : '将扬声器静音';
  return (
    <div role="group" aria-label="语音控制" className="flex shrink-0 items-center gap-2">
      <button type="button" aria-label={speakerLabel} title={speakerLabel} aria-pressed={speakerMuted}
        onClick={() => onSpeakerMutedChange(!speakerMuted)} className={muteButtonClass(speakerMuted)}>
        <ControlIcon name={speakerMuted ? 'speakerMuted' : 'speaker'} />
      </button>
      <button type="button" aria-label={microphoneLabel} title={microphoneLabel} aria-pressed={muted}
        onClick={() => onMutedChange(!muted)} className={muteButtonClass(muted)}>
        <ControlIcon name={muted ? 'microphoneMuted' : 'microphone'} />
      </button>
      <button type="button" aria-label="结束连接" title="结束连接" onClick={onEnd}
        className="grid h-10 w-10 place-items-center rounded-full bg-red-400 text-white transition-colors duration-150 hover:bg-red-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500">
        <ControlIcon name="stop" size={18} />
      </button>
    </div>
  );
}
