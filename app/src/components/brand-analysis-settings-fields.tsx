'use client';

import { useEffect, useState } from 'react';
import { SeverityBadge } from '@/components/severity-badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  ANALYSIS_SEVERITY_ORDER,
  DEFAULT_ANALYSIS_SEVERITY_DEFINITIONS,
  MAX_ANALYSIS_SEVERITY_DEFINITION_LENGTH,
} from '@/lib/analysis-severity';
import type { BrandAnalysisSeverityDefinitions, Severity } from '@/lib/types';

type BrandAnalysisSettingsFieldsProps = {
  value?: BrandAnalysisSeverityDefinitions;
  onChange: (value: BrandAnalysisSeverityDefinitions) => void;
};

export function BrandAnalysisSettingsFields({
  value,
  onChange,
}: BrandAnalysisSettingsFieldsProps) {
  const definitions = value ?? {};
  const [pendingDisableSeverity, setPendingDisableSeverity] = useState<Severity | null>(null);

  useEffect(() => {
    if (!pendingDisableSeverity) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPendingDisableSeverity(null);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pendingDisableSeverity]);

  function updateSeverity(severity: Severity, nextValue?: string) {
    const nextDefinitions: BrandAnalysisSeverityDefinitions = { ...definitions };

    if (typeof nextValue === 'string') {
      nextDefinitions[severity] = nextValue;
    } else {
      delete nextDefinitions[severity];
    }

    onChange(nextDefinitions);
  }

  function handleToggle(severity: Severity) {
    const currentValue = definitions[severity];
    if (typeof currentValue === 'string') {
      if (currentValue.trim() !== DEFAULT_ANALYSIS_SEVERITY_DEFINITIONS[severity]) {
        setPendingDisableSeverity(severity);
        return;
      }

      updateSeverity(severity);
      return;
    }

    updateSeverity(severity, DEFAULT_ANALYSIS_SEVERITY_DEFINITIONS[severity]);
  }

  function confirmDisable(severity: Severity) {
    updateSeverity(severity);
    setPendingDisableSeverity(null);
  }

  return (
    <>
      <div className="space-y-5">
        <p className="text-sm text-gray-500">
          Customise the definitions that DoppelSpotter&apos;s AI analysis uses to categorise findings.
        </p>

        {ANALYSIS_SEVERITY_ORDER.map((severity) => {
          const isCustom = typeof definitions[severity] === 'string';
          const currentValue = definitions[severity] ?? DEFAULT_ANALYSIS_SEVERITY_DEFINITIONS[severity];
          const trimmedLength = currentValue.trim().length;
          const fieldError = isCustom && trimmedLength === 0
            ? 'Enter a definition or switch customisation off.'
            : undefined;

          return (
            <div key={severity} className="rounded-2xl border border-gray-200 bg-gray-50/60 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <SeverityBadge severity={severity} className="w-full justify-start sm:w-auto" />
                <button
                  type="button"
                  role="switch"
                  aria-checked={isCustom}
                  aria-label={`Toggle customisation for ${severity} severity`}
                  onClick={() => handleToggle(severity)}
                  className={`inline-flex items-center gap-2 rounded-md text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    isCustom ? 'text-brand-700' : 'text-gray-600'
                  } self-start sm:self-auto`}
                >
                  <span>{isCustom ? 'Customisation on' : 'Customisation off'}</span>
                  <span
                    className={`relative inline-flex h-6 w-11 rounded-full transition ${
                      isCustom ? 'bg-brand-600' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                        isCustom ? 'left-[22px]' : 'left-0.5'
                      }`}
                    />
                  </span>
                </button>
              </div>

              <div className="mt-4">
                <Textarea
                  id={`analysis-severity-${severity}`}
                  value={currentValue}
                  onChange={(event) => updateSeverity(severity, event.target.value)}
                  disabled={!isCustom}
                  rows={4}
                  maxLength={MAX_ANALYSIS_SEVERITY_DEFINITION_LENGTH}
                  error={fieldError}
                  className={!isCustom ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 placeholder:text-gray-400' : undefined}
                />
                <div className="mt-2 flex items-center justify-between gap-4 text-xs text-gray-500">
                  <span>{trimmedLength}/{MAX_ANALYSIS_SEVERITY_DEFINITION_LENGTH}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {pendingDisableSeverity && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/60 px-4"
          onClick={() => setPendingDisableSeverity(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="disable-analysis-customisation-title"
            aria-describedby="disable-analysis-customisation-description"
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="space-y-2">
              <h2 id="disable-analysis-customisation-title" className="text-lg font-semibold text-gray-900">
                Revert definition?
              </h2>
              <p id="disable-analysis-customisation-description" className="text-sm leading-6 text-gray-600">
                Your custom definition will be removed and the default DoppelSpotter definition will be used.
              </p>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPendingDisableSeverity(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => confirmDisable(pendingDisableSeverity)}
              >
                Revert to default
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
