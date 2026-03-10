'use client';

import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn, formatInteger } from '@/lib/utils';

type DashboardMetricCardTone = 'danger' | 'warning' | 'success' | 'neutral';

type DashboardMetricCardProps = {
  label: string;
  value: number;
  description: string;
  icon: LucideIcon;
  tone: DashboardMetricCardTone;
  onClick?: () => void;
};

const toneClasses: Record<DashboardMetricCardTone, { accent: string; icon: string; badge: string }> = {
  danger: {
    accent: '!border-red-200',
    icon: 'text-red-600',
    badge: 'bg-red-50',
  },
  warning: {
    accent: '!border-amber-300',
    icon: 'text-amber-600',
    badge: 'bg-amber-50',
  },
  success: {
    accent: '!border-emerald-300',
    icon: 'text-emerald-600',
    badge: 'bg-emerald-50',
  },
  neutral: {
    accent: '!border-slate-200',
    icon: 'text-slate-600',
    badge: 'bg-slate-50',
  },
};

export function DashboardMetricCard({
  label,
  value,
  description,
  icon: Icon,
  tone,
  onClick,
}: DashboardMetricCardProps) {
  const toneClass = toneClasses[tone];

  return (
    <Card
      className={cn(
        'overflow-hidden !border-t-4',
        toneClass.accent,
        onClick && 'transition hover:bg-gray-50',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        className={cn(
          'flex h-full w-full items-start justify-between gap-4 px-5 py-5 text-left',
          onClick && 'cursor-pointer',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-inset',
        )}
      >
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-500">{label}</p>
          <p className="text-3xl font-semibold tracking-tight text-gray-900">{formatInteger(value)}</p>
          <p className="text-sm text-gray-500">{description}</p>
        </div>
        <div className={cn('flex h-11 w-11 flex-none aspect-square items-center justify-center rounded-full', toneClass.badge)}>
          <Icon className={cn('h-5 w-5', toneClass.icon)} />
        </div>
      </button>
    </Card>
  );
}
