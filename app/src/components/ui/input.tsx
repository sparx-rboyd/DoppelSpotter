import { type InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { InfoTooltip } from '@/components/ui/tooltip';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  tooltip?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
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
      <input
        ref={ref}
        id={id}
        className={cn(
          'w-full px-3 py-2 rounded-lg border text-sm text-gray-900 placeholder-gray-400 transition',
          'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent',
          error ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white',
          className,
        )}
        {...props}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
});
