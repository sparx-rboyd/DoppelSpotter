import { Info } from 'lucide-react';

interface InfoTooltipProps {
  content: string;
}

export function InfoTooltip({ content }: InfoTooltipProps) {
  return (
    <span className="relative inline-flex group/tooltip">
      <span
        role="img"
        aria-label="More information"
        className="inline-flex text-gray-400 hover:text-gray-500 transition-colors cursor-default"
      >
        <Info className="w-3.5 h-3.5" />
      </span>
      <span
        role="tooltip"
        className={[
          'pointer-events-none absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2',
          'w-60 bg-white border border-gray-200 text-gray-600 text-xs rounded-lg px-3 py-2.5 shadow-lg leading-relaxed',
          'normal-case tracking-normal font-normal',
          'opacity-0 group-hover/tooltip:opacity-100 transition-opacity duration-150',
        ].join(' ')}
      >
        {content}
        {/* Arrow: border layer */}
        <span className="absolute top-full left-1/2 -translate-x-1/2 border-[5px] border-transparent border-t-gray-200" />
        {/* Arrow: fill layer */}
        <span className="absolute top-full left-1/2 -translate-x-1/2 mt-[-1px] border-[4px] border-transparent border-t-white" />
      </span>
    </span>
  );
}
