import { Info } from 'lucide-react';

interface InfoTooltipProps {
  content: string;
  iconClassName?: string;
}

export function InfoTooltip({ content, iconClassName }: InfoTooltipProps) {
  return (
    <span className="relative inline-flex group/tooltip">
      <span
        role="img"
        aria-label="More information"
        className={`inline-flex transition-colors cursor-default ${iconClassName ?? 'text-gray-400 hover:text-gray-500'}`}
      >
        <Info className="w-3.5 h-3.5" />
      </span>
      <span
        role="tooltip"
        className={[
          'pointer-events-none absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2',
          'w-60 bg-gray-900 text-white text-xs rounded-lg px-3 py-2.5 leading-relaxed',
          'normal-case tracking-normal font-normal',
          'opacity-0 group-hover/tooltip:opacity-100 transition-opacity duration-150',
        ].join(' ')}
      >
        {content}
        {/* Arrow: fill layer */}
        <span className="absolute top-full left-1/2 -translate-x-1/2 border-[5px] border-transparent border-t-gray-900" />
      </span>
    </span>
  );
}
