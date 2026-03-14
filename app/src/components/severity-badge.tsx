import { AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type Severity } from '@/lib/types';
import { Badge } from './ui/badge';

interface SeverityBadgeProps {
  severity: Severity;
  className?: string;
}

const config = {
  high: {
    variant: 'danger' as const,
    label: 'High Severity',
    icon: AlertCircle,
  },
  medium: {
    variant: 'warning' as const,
    label: 'Medium Severity',
    icon: AlertTriangle,
  },
  low: {
    variant: 'success' as const,
    label: 'Low Severity',
    icon: Info,
  },
};

export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
  const { variant, label, icon: Icon } = config[severity];
  return (
    <Badge variant={variant} className={cn(className)}>
      <Icon className="w-3.5 h-3.5" />
      {label}
    </Badge>
  );
}
