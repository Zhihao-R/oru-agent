// @vitest-environment node

/** profile 命名空间（编辑资料/头像裁剪/双头像）+ app.addProject 扩展中文文案快照基线。
 *  称呼收敛已落地：原「编辑分身」「分身的名字」改接个体名 {{name}}（无名回落 Oru）。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('profile zh 文案快照', () => {
  it('编辑资料对话框（称呼收敛：标题/名字占位接个体名、名字校验插值）', () => {
    expect(t('profile:title', { name: '阿果' })).toBe('编辑 阿果');
    expect(t('profile:editAria', { name: '阿果' })).toBe('编辑 阿果');
    expect(t('profile:user')).toBe('你');
    expect(t('profile:changeImage')).toBe('更换图片');
    expect(t('profile:userNamePlaceholder')).toBe('你的名字');
    expect(t('profile:twinNamePlaceholder', { name: '阿果' })).toBe('阿果 的名字');
    expect(t('profile:nameEmpty')).toBe('名字不能为空');
    expect(t('profile:nameTooLong', { max: 20 })).toBe('名字最多 20 字');
    expect(t('profile:pickFileFailed')).toBe('选择文件失败');
    expect(t('profile:saveFailed')).toBe('保存失败');
  });

  it('头像校验/上传错误（avatarUpload 抛出，含格式/协议类型插值）', () => {
    expect(t('profile:avatarBadFormat', { type: 'image/bmp' })).toBe('不支持的格式：image/bmp。请上传 jpg / png / webp');
    expect(t('profile:avatarTooLarge')).toBe('图片太大了，建议小于 5MB');
    // onSave catch 直接显示 err.message，故协议异常也是用户面（zh 字面保留 unexpected response）
    expect(t('profile:avatarUploadFailed', { type: 'agents.x' })).toBe('上传失败：unexpected response agents.x');
  });

  it('头像裁剪', () => {
    expect(t('profile:crop.title')).toBe('调整头像');
    expect(t('profile:crop.zoom')).toBe('缩放');
    expect(t('profile:crop.confirm')).toBe('确认');
  });
});

describe('app.addProject zh 文案快照（并入 app ns）', () => {
  it('添加项目对话框', () => {
    expect(t('app:addProject.title')).toBe('添加项目');
    expect(t('app:addProject.description')).toBe('把文件夹从 Finder 拖进来，或点击下面浏览选择。');
    expect(t('app:addProject.dropError')).toBe('未识别到文件夹路径，请改用浏览选择');
    expect(t('app:addProject.adding')).toBe('添加中…');
    expect(t('app:addProject.releaseToAdd')).toBe('松手添加');
    expect(t('app:addProject.dropHint')).toBe('拖文件夹到这里，或点击浏览');
    expect(t('app:addProject.fromFinder')).toBe('来自 Finder · 自动取绝对路径');
  });
});
