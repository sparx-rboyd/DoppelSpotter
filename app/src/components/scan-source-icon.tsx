'use client';

import { Globe, Router } from 'lucide-react';
import type { FindingSource } from '@/lib/types';
import { cn } from '@/lib/utils';

type ScanSourceIconProps = {
  source: FindingSource;
  className?: string;
};

function MaskedSvgIcon({ src, className }: { src: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block bg-current', className)}
      style={{
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  );
}

export function ScanSourceIcon({ source, className }: ScanSourceIconProps) {
  if (source === 'reddit') {
    return <MaskedSvgIcon src="/reddit.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  if (source === 'tiktok') {
    return <MaskedSvgIcon src="/tiktok.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  if (source === 'youtube') {
    return <MaskedSvgIcon src="/youtube.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  if (source === 'facebook') {
    return <MaskedSvgIcon src="/facebook.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  if (source === 'instagram') {
    return <MaskedSvgIcon src="/instagram.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  if (source === 'telegram') {
    return <MaskedSvgIcon src="/telegram.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  if (source === 'apple_app_store') {
    return <MaskedSvgIcon src="/appstore.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  if (source === 'google_play') {
    return <MaskedSvgIcon src="/googleplay.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  if (source === 'discord') {
    return <MaskedSvgIcon src="/discord.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  if (source === 'domains') {
    return <Router className={cn('h-[18px] w-[18px]', className)} aria-hidden="true" />;
  }

  if (source === 'github') {
    return <MaskedSvgIcon src="/github.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  if (source === 'x') {
    return <MaskedSvgIcon src="/x.svg" className={cn('h-[18px] w-[18px]', className)} />;
  }

  return <Globe className={cn('h-[18px] w-[18px]', className)} aria-hidden="true" />;
}
