'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DashboardTimelineSeries } from '@/lib/types';

type DashboardSeriesFilterProps = {
  buttonLabelSingular: string;
  buttonLabelPlural: string;
  options: DashboardTimelineSeries[];
  selectedKeys: string[];
  onChange: (keys: string[]) => void;
  className?: string;
};

export function DashboardSeriesFilter({
  buttonLabelSingular,
  buttonLabelPlural,
  options,
  selectedKeys,
  onChange,
  className,
}: DashboardSeriesFilterProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedKeySet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const selectedCount = selectedKeys.length;
  const [isOpen, setIsOpen] = useState(false);
  const buttonLabel = `${selectedCount} ${selectedCount === 1 ? buttonLabelSingular : buttonLabelPlural} selected`;

  useEffect(() => {
    if (!isOpen) return undefined;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target || rootRef.current?.contains(target)) return;
      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  function toggleKey(key: string) {
    const nextSelected = selectedKeySet.has(key)
      ? selectedKeys.filter((value) => value !== key)
      : [...selectedKeys, key];

    const orderedSelected = options
      .map((option) => option.key)
      .filter((optionKey) => nextSelected.includes(optionKey));

    onChange(orderedSelected);
  }

  function handleSelectAll() {
    onChange(options.map((option) => option.key));
  }

  function handleClearAll() {
    onChange([]);
  }

  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        disabled={options.length === 0}
        onClick={() => setIsOpen((current) => !current)}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 text-xs font-medium text-gray-900 transition hover:border-gray-300 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:text-slate-400',
        )}
      >
        <span className="whitespace-nowrap">{buttonLabel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-gray-500 transition', isOpen && 'rotate-180')} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-[230] mt-2 w-[15rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-gray-100 px-2.5 py-2">
            <button
              type="button"
              onClick={handleSelectAll}
              className="text-[11px] font-medium text-brand-700 transition hover:text-brand-800"
            >
              All
            </button>
            <button
              type="button"
              onClick={handleClearAll}
              className="text-[11px] font-medium text-slate-500 transition hover:text-slate-700"
            >
              Clear
            </button>
          </div>

          <div className="max-h-[16rem] overflow-y-auto p-1.5">
            <div className="space-y-0.5">
              {options.map((option) => {
                const isChecked = selectedKeySet.has(option.key);

                return (
                  <label
                    key={option.key}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={isChecked}
                      onChange={() => toggleKey(option.key)}
                    />
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 flex-none items-center justify-center rounded border transition',
                        isChecked
                          ? 'border-brand-500 bg-brand-600 text-white'
                          : 'border-slate-300 bg-white text-transparent',
                      )}
                    >
                      <Check className="h-2.5 w-2.5" />
                    </span>
                    <span
                      className="h-2 w-2 flex-none rounded-full"
                      style={{ backgroundColor: option.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-700">{option.label}</span>
                    <span className="text-[11px] text-slate-400">{option.total}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
