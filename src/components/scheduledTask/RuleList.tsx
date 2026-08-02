/**
 * 触发时间清单（多触发规则）：每条一行频率摘要，点开在「添加触发时间」弹窗里编辑，可增可删（至少一条）。
 * 编辑单条走独立弹窗 TriggerModal（照设计稿），前端只持有各条 SpecForm。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { defaultForm, describeForm, type SpecForm } from './specForm';
import { TriggerModal } from './TriggerModal';

/** 编辑态一条规则：key 供 React 稳定渲染；taskId 回填既有规则时带上（组写 diff 按它对齐）。 */
export type EditRule = { key: string; taskId?: string; form: SpecForm };

let seq = 0;
export function newEditRule(form: SpecForm = defaultForm(), taskId?: string): EditRule {
  seq += 1;
  return { key: `r${seq}`, taskId, form };
}

export function RuleList({
  rules,
  onChange,
}: {
  rules: EditRule[];
  onChange: (rules: EditRule[]) => void;
}) {
  const { t } = useTranslation('scheduledTask');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const editingRule = rules.find((r) => r.key === editingKey);

  return (
    <div className="space-y-2">
      {rules.map((r) => (
        <div
          key={r.key}
          className="group flex items-center gap-2 rounded-lg border border-border bg-sunken px-3.5 py-3 transition-colors hover:border-accent-ring"
        >
          <button onClick={() => setEditingKey(r.key)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <span className="truncate text-sm text-text-primary">{describeForm(r.form, t)}</span>
            <ChevronRight size={14} className="shrink-0 text-text-tertiary" />
          </button>
          {rules.length > 1 ? (
            <button
              onClick={() => onChange(rules.filter((x) => x.key !== r.key))}
              aria-label={t('rule.remove')}
              className="shrink-0 text-text-tertiary opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
            >
              <Trash2 size={15} />
            </button>
          ) : null}
        </div>
      ))}
      <button
        onClick={() => setAdding(true)}
        className={cn(
          'flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2.5',
          'text-sm font-medium text-text-secondary transition-colors hover:border-accent-ring hover:text-accent-deep',
        )}
      >
        <Plus size={15} /> {t('rule.addTrigger')}
      </button>

      {adding ? (
        <TriggerModal
          initial={defaultForm()}
          editing={false}
          onCancel={() => setAdding(false)}
          onSave={(form) => {
            onChange([...rules, newEditRule(form)]);
            setAdding(false);
          }}
        />
      ) : null}
      {editingRule ? (
        <TriggerModal
          initial={editingRule.form}
          editing
          onCancel={() => setEditingKey(null)}
          onSave={(form) => {
            onChange(rules.map((r) => (r.key === editingKey ? { ...r, form } : r)));
            setEditingKey(null);
          }}
        />
      ) : null}
    </div>
  );
}
