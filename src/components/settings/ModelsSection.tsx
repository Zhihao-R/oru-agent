/**
 * Settings ▸ 模型
 *
 * 包装层——只画 H1 + max-width；具体内容在 BackendSettingsSection。
 */
import { useTranslation } from 'react-i18next';
import { BackendSettingsSection } from '@/components/BackendSettingsSection';

export function ModelsSection() {
  const { t } = useTranslation('settings');
  return (
    <div className="mx-auto max-w-[640px] px-12 py-12">
      <h1 className="mb-9 font-serif text-[30px] font-semibold leading-[1.15] tracking-tight">
        {t('models.heading')}
      </h1>
      <BackendSettingsSection />
    </div>
  );
}
