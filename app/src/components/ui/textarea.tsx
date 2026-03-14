import { type TextareaHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { InfoTooltip } from '@/components/ui/tooltip';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  tooltip?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, tooltip, className, id, ...props },
  ref,
) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
          {label}
          {tooltip && <InfoTooltip content={tooltip} />}
        </label>
      )}
      <textarea
        ref={ref}
        id={id}
        className={cn(
          'brand-form-input w-full rounded-lg border px-3 py-2 text-sm text-gray-900 transition lg:py-3',
          'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent',
          'disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400 disabled:opacity-100',
          error ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white',
          className,
        )}
        {...props}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
});
