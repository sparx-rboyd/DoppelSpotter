'use client';

import { type FocusEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

type TooltipAlign = 'center' | 'end';

interface TooltipProps {
  content: string;
  children: ReactNode;
  align?: TooltipAlign;
  contentClassName?: string;
  triggerClassName?: string;
}

interface InfoTooltipProps {
  content: string;
  iconClassName?: string;
}

const TOOLTIP_GAP_PX = 8;

export function Tooltip({
  content,
  children,
  align = 'center',
  contentClassName,
  triggerClassName,
}: TooltipProps) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    if (!triggerEl) return;

    const rect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth;
    // Max tooltip width is max-w-xs = 320px; leave 8px viewport margin
    const TOOLTIP_MAX_WIDTH = 320;
    const VIEWPORT_MARGIN = 8;

    let rawLeft = align === 'end' ? rect.right : rect.left + rect.width / 2;

    if (align === 'center') {
      // Clamp so the centred tooltip (translated -50%) doesn't overflow either edge
      const halfWidth = TOOLTIP_MAX_WIDTH / 2;
      rawLeft = Math.max(halfWidth + VIEWPORT_MARGIN, Math.min(rawLeft, vw - halfWidth - VIEWPORT_MARGIN));
    } else {
      // 'end' alignment: tooltip is translated -100% on X, so clamp its left edge
      rawLeft = Math.min(rawLeft, vw - VIEWPORT_MARGIN);
      rawLeft = Math.max(TOOLTIP_MAX_WIDTH + VIEWPORT_MARGIN, rawLeft);
    }

    setPosition({
      top: rect.top - TOOLTIP_GAP_PX,
      left: rawLeft,
    });
  }, [align]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    updatePosition();

    function handleViewportChange() {
      updatePosition();
    }

    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [isOpen, updatePosition]);

  function handleBlur(event: FocusEvent<HTMLSpanElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsOpen(false);
  }

  return (
    <>
      <span
        ref={triggerRef}
        className={cn('inline-flex', triggerClassName)}
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
        onFocus={() => setIsOpen(true)}
        onBlur={handleBlur}
        aria-describedby={isOpen ? tooltipId : undefined}
      >
        {children}
      </span>
      {isMounted && isOpen && createPortal(
        <span
          id={tooltipId}
          role="tooltip"
          className={cn(
            'pointer-events-none fixed z-[100] max-w-xs rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-xs font-normal leading-relaxed text-white',
            align === 'center' ? '-translate-x-1/2 -translate-y-full' : '-translate-x-full -translate-y-full',
            contentClassName,
          )}
          style={{ left: position.left, top: position.top }}
        >
          {content}
          <span
            className={cn(
              'absolute top-full border-[5px] border-transparent border-t-gray-900',
              align === 'center' ? 'left-1/2 -translate-x-1/2' : 'right-3',
            )}
          />
        </span>,
        document.body,
      )}
    </>
  );
}

export function InfoTooltip({ content, iconClassName }: InfoTooltipProps) {
  return (
    <Tooltip content={content}>
      <span
        role="img"
        aria-label="More information"
        className={cn('inline-flex cursor-default transition-colors', iconClassName ?? 'text-gray-400 hover:text-gray-500')}
      >
        <Info className="w-3.5 h-3.5" />
      </span>
    </Tooltip>
  );
}
