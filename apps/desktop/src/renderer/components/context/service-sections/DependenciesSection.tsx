import { useState } from 'react';
import { Package, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '../../ui/collapsible';

interface DependenciesSectionProps {
  dependencies: string[];
}

export function DependenciesSection({ dependencies }: DependenciesSectionProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);

  if (!dependencies || dependencies.length === 0) {
    return null;
  }

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="border-t border-border pt-3"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between text-xs font-medium hover:text-foreground">
        <div className="flex items-center gap-2">
          <Package className="h-3 w-3" />
          {t('context.projectIndex.labels.dependencies', { defaultValue: 'Dependencies' })} ({dependencies.length})
        </div>
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <div className="flex flex-wrap gap-1">
          {dependencies.slice(0, 20).map(dep => (
            <Badge key={dep} variant="outline" className="text-xs font-mono">
              {dep}
            </Badge>
          ))}
          {dependencies.length > 20 && (
            <Badge variant="secondary" className="text-xs">
              {t('context.projectIndex.labels.more', {
                count: dependencies.length - 20,
                defaultValue: `+${dependencies.length - 20} more`
              })}
            </Badge>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
