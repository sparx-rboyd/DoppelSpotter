'use client';

import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

type DashboardCtaCardProps = {
  eyebrow?: string;
  title: string;
  description: string;
  href: string;
  actionLabel: string;
  icon: LucideIcon;
  iconClassName?: string;
};

export function DashboardCtaCard({
  eyebrow,
  title,
  description,
  href,
  actionLabel,
  icon: Icon,
  iconClassName,
}: DashboardCtaCardProps) {
  return (
    <Link
      href={href}
      className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-50"
    >
      <section className="relative overflow-hidden rounded-xl border border-brand-100/80 bg-[linear-gradient(135deg,#0369a1_0%,#0284c7_52%,#0ea5e9_100%)] px-6 py-8 text-white sm:px-8 sm:py-10">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.14),transparent_42%)]" />
        <div className="absolute -right-10 top-1/2 h-32 w-32 -translate-y-1/2 rounded-full bg-white/8 blur-3xl" />

        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/12">
              <Icon className={cn('h-7 w-7', iconClassName)} />
            </div>
            {eyebrow ? (
              <p className="mt-5 text-xs font-semibold uppercase tracking-[0.14em] text-white/70">{eyebrow}</p>
            ) : null}
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-white/80 sm:text-base">{description}</p>
          </div>

          <span
            className="inline-flex items-center justify-center gap-2 self-start rounded-full bg-white px-5 py-3 text-sm font-semibold text-brand-700 transition group-hover:bg-brand-50 group-focus-visible:bg-brand-50"
          >
            {actionLabel}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
          </span>
        </div>
      </section>
    </Link>
  );
}
