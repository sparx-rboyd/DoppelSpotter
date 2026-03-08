'use client';

import {
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { InfoTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type SelectDropdownOption = {
  value: string;
  label: string;
};

type FloatingPanelProps = {
  anchorRef: MutableRefObject<HTMLElement | null>;
  isOpen: boolean;
  onClose: () => void;
  matchTriggerWidth?: boolean;
  className?: string;
  children: ReactNode;
};

type SelectDropdownProps = {
  id: string;
  value: string;
  options: SelectDropdownOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  label?: ReactNode;
  tooltip?: string;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  buttonIcon?: ReactNode;
  labelTone?: 'default' | 'subtle';
  emptyMessage?: string;
  triggerClassName?: string;
  panelClassName?: string;
  matchTriggerWidth?: boolean;
  dividerAfterValue?: string;
};

const FLOATING_PANEL_GAP_PX = 8;
const FLOATING_PANEL_VIEWPORT_MARGIN_PX = 12;

function buildFieldLabel(
  id: string,
  label: ReactNode,
  tooltip?: string,
  tone: 'default' | 'subtle' = 'default',
) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'inline-flex items-center gap-1.5 font-medium',
        tone === 'subtle' ? 'text-xs text-gray-500' : 'text-sm text-gray-700',
      )}
    >
      {label}
      {tooltip ? <InfoTooltip content={tooltip} /> : null}
    </label>
  );
}

function buildTriggerButtonClassName(disabled?: boolean, customClassName?: string) {
  return cn(
    'brand-form-input flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm text-gray-900 transition',
    'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent',
    'border-gray-300 bg-white',
    disabled && 'cursor-not-allowed bg-gray-50 text-gray-400',
    customClassName,
  );
}

function FloatingPanel({
  anchorRef,
  isOpen,
  onClose,
  matchTriggerWidth = true,
  className,
  children,
}: FloatingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [isMounted, setIsMounted] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 0 });

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const panelRect = panelRef.current?.getBoundingClientRect();
    const naturalPanelWidth = matchTriggerWidth
      ? rect.width
      : panelRef.current?.scrollWidth ?? panelRect?.width ?? rect.width;
    const naturalPanelHeight = panelRef.current?.scrollHeight ?? panelRect?.height ?? 0;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const preferredTop = rect.bottom + FLOATING_PANEL_GAP_PX;
    const maxLeft = Math.max(
      FLOATING_PANEL_VIEWPORT_MARGIN_PX,
      viewportWidth - naturalPanelWidth - FLOATING_PANEL_VIEWPORT_MARGIN_PX,
    );
    const left = Math.max(
      FLOATING_PANEL_VIEWPORT_MARGIN_PX,
      Math.min(rect.left, maxLeft),
    );

    const spaceBelow = viewportHeight - preferredTop - FLOATING_PANEL_VIEWPORT_MARGIN_PX;
    const spaceAbove = rect.top - FLOATING_PANEL_GAP_PX - FLOATING_PANEL_VIEWPORT_MARGIN_PX;
    const shouldRenderAbove =
      naturalPanelHeight > 0 &&
      spaceBelow < naturalPanelHeight &&
      spaceAbove > spaceBelow;

    const maxHeight = Math.max(
      0,
      shouldRenderAbove ? spaceAbove : spaceBelow,
    );
    const renderedPanelHeight = naturalPanelHeight > 0
      ? Math.min(naturalPanelHeight, maxHeight)
      : maxHeight;

    const top = shouldRenderAbove
      ? Math.max(
          FLOATING_PANEL_VIEWPORT_MARGIN_PX,
          rect.top - FLOATING_PANEL_GAP_PX - renderedPanelHeight,
        )
      : Math.max(
          FLOATING_PANEL_VIEWPORT_MARGIN_PX,
          Math.min(
            preferredTop,
            viewportHeight - FLOATING_PANEL_VIEWPORT_MARGIN_PX - renderedPanelHeight,
          ),
        );

    setPosition((current) => {
      const nextPosition = {
        top,
        left,
        width: rect.width,
        maxHeight,
      };

      if (
        current.top === nextPosition.top &&
        current.left === nextPosition.left &&
        current.width === nextPosition.width &&
        current.maxHeight === nextPosition.maxHeight
      ) {
        return current;
      }

      return nextPosition;
    });
  }, [anchorRef, matchTriggerWidth]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;

    updatePosition();
    const frameId = window.requestAnimationFrame(updatePosition);

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCloseRef.current();
      }
    }

    function handleViewportChange() {
      updatePosition();
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [anchorRef, isOpen, updatePosition]);

  if (!isMounted || !isOpen) {
    return null;
  }

  return createPortal(
    <div
      ref={panelRef}
      className={cn(
        'fixed z-[120] overflow-y-auto rounded-xl border border-gray-200 bg-white p-2',
        className,
      )}
      style={{
        top: position.top,
        left: position.left,
        width: matchTriggerWidth ? position.width : undefined,
        maxHeight: position.maxHeight,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function SelectDropdown({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  label,
  tooltip,
  disabled,
  searchable = false,
  searchPlaceholder = 'Search…',
  buttonIcon,
  labelTone = 'default',
  emptyMessage = 'No matching options.',
  triggerClassName,
  panelClassName,
  matchTriggerWidth = true,
  dividerAfterValue,
}: SelectDropdownProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [scrollCueState, setScrollCueState] = useState({ showTop: false, showBottom: false });

  const selectedOption = options.find((option) => option.value === value) ?? options[0];
  const filteredOptions = useMemo(() => {
    if (!searchable || !query.trim()) return options;

    const normalizedQuery = query.trim().toLowerCase();
    return options.filter((option) => option.label.toLowerCase().includes(normalizedQuery));
  }, [options, query, searchable]);

  const updateScrollCues = useCallback(() => {
    const container = listContainerRef.current;
    if (!container) {
      setScrollCueState((current) => (
        current.showTop || current.showBottom
          ? { showTop: false, showBottom: false }
          : current
      ));
      return;
    }

    const canScroll = container.scrollHeight - container.clientHeight > 1;
    const showTop = canScroll && container.scrollTop > 1;
    const showBottom = canScroll && container.scrollTop + container.clientHeight < container.scrollHeight - 1;

    setScrollCueState((current) => (
      current.showTop === showTop && current.showBottom === showBottom
        ? current
        : { showTop, showBottom }
    ));
  }, []);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
    }
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setScrollCueState((current) => (
        current.showTop || current.showBottom
          ? { showTop: false, showBottom: false }
          : current
      ));
      return;
    }

    const frameId = window.requestAnimationFrame(updateScrollCues);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [filteredOptions, isOpen, updateScrollCues]);

  return (
    <div className="flex flex-col gap-1">
      {label ? buildFieldLabel(id, label, tooltip, labelTone) : null}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onClick={() => {
          if (!disabled) setIsOpen((current) => !current);
        }}
        className={buildTriggerButtonClassName(disabled, triggerClassName)}
      >
        {buttonIcon}
        <span className="min-w-0 flex-1 truncate text-left">
          {selectedOption?.label ?? value}
        </span>
        <ChevronDown className={cn('h-4 w-4 text-gray-400 transition', isOpen && 'rotate-180')} />
      </button>

      <FloatingPanel
        anchorRef={triggerRef as MutableRefObject<HTMLElement | null>}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        matchTriggerWidth={matchTriggerWidth}
        className={panelClassName}
      >
        {searchable && (
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-9 pr-3 text-sm text-gray-900 outline-none transition focus:border-brand-300 focus:bg-white"
            />
          </div>
        )}

        <div className="relative">
          <div
            ref={listContainerRef}
            className="max-h-64 overflow-auto"
            onScroll={updateScrollCues}
          >
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option, index) => {
                const isSelected = option.value === value;
                const shouldShowDivider = option.value === dividerAfterValue && index < filteredOptions.length - 1;
                return (
                  <div
                    key={option.value}
                    className={cn(shouldShowDivider && 'mb-1 border-b border-gray-100 pb-1')}
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        onChange(option.value);
                        setIsOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm transition',
                        isSelected
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-gray-700 hover:bg-gray-50',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
                      <Check className={cn('h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')} />
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="px-3 py-2 text-sm text-gray-400">{emptyMessage}</p>
            )}
          </div>

          {scrollCueState.showTop && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-6 items-start justify-center bg-gradient-to-b from-white via-white/95 to-transparent"
            >
              <ChevronDown className="mt-0.5 h-3.5 w-3.5 rotate-180 text-gray-300" />
            </div>
          )}

          {scrollCueState.showBottom && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex h-6 items-end justify-center bg-gradient-to-t from-white via-white/95 to-transparent"
            >
              <ChevronDown className="mb-0.5 h-3.5 w-3.5 text-gray-300" />
            </div>
          )}
        </div>
      </FloatingPanel>
    </div>
  );
}
