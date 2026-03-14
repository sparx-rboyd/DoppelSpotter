import { type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { InfoTooltip } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TagInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  id: string;
  label?: ReactNode;
  tooltip?: string;
  values: string[];
  inputValue: string;
  onInputChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (value: string) => void;
  error?: string;
  hint?: ReactNode;
  inputDisabled?: boolean;
}

export function TagInput({
  id,
  label,
  tooltip,
  values,
  inputValue,
  onInputChange,
  onAdd,
  onRemove,
  error,
  hint,
  inputDisabled = false,
  placeholder,
  className,
  disabled,
  ...props
}: TagInputProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      onAdd();
      return;
    }

    if (event.key === 'Backspace' && !inputValue && values.length > 0) {
      onRemove(values[values.length - 1]);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
          {label}
          {tooltip && <InfoTooltip content={tooltip} />}
        </label>
      )}
      <div
        className={cn(
          'flex min-h-11 w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm transition lg:min-h-12 lg:px-4 lg:py-3',
          'focus-within:border-transparent focus-within:ring-2 focus-within:ring-brand-500',
          error ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white',
          disabled && 'cursor-not-allowed opacity-60',
          className,
        )}
      >
        {values.map((value) => (
          <Badge key={value} variant="default" className="max-w-full">
            <span className="max-w-[16rem] truncate">{value}</span>
            <button
              type="button"
              onClick={() => onRemove(value)}
              className="rounded-sm hover:opacity-70 focus:outline-none focus:ring-2 focus:ring-brand-500"
              aria-label={`Remove ${value}`}
              disabled={disabled}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          type="text"
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={values.length === 0 ? placeholder : undefined}
          className="brand-form-input min-w-[10rem] flex-1 border-0 bg-transparent p-0 text-sm text-gray-900 focus:outline-none focus:ring-0"
          aria-invalid={Boolean(error)}
          disabled={disabled || inputDisabled}
          {...props}
        />
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : hint ? <p className="text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}
