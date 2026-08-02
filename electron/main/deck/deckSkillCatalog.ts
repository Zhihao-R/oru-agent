/**
 * Deck skill 默认指向 + 引导安装清单。
 *
 * Oru 不打包任何 deck skill（PRD D2：全部走引导安装、口径统一、不为每个候选维护 builtin 副本）。
 * 默认指向 html-ppt-skill（MIT，与 Oru 分页/尺寸约定原生吻合，实测 8 页 `<section class="slide">`、
 * 用 vw/vh 撑满视口、未声明尺寸退默认 16:9 正好对）。`id` = 装进 `~/.oru/skills/<id>/` 的裸文件夹名
 * = 注册表 id（read_skill 按此解析）。
 */

/** 默认 deck skill 的注册表 id（= 安装目录裸名）。模型未显式给 deck_skill_id 时 fallback 到它。 */
export const DEFAULT_DECK_SKILL_ID = 'html-ppt-skill';

export type CuratedDeckSkill = {
  /** 注册表 id = 安装目录裸文件夹名 */
  id: string;
  /** 展示名 */
  name: string;
  /** git clone 源 */
  repo: string;
  license: string;
  /** 引导卡上的一句话说明 */
  note: string;
};

/**
 * 引导卡候选清单。默认项排首位。用户也可在对话里给任意 skill 仓库地址（不限于此清单）。
 */
export const CURATED_DECK_SKILLS: CuratedDeckSkill[] = [
  {
    id: DEFAULT_DECK_SKILL_ID,
    name: 'HTML PPT Studio',
    repo: 'https://github.com/lewislulu/html-ppt-skill',
    license: 'MIT',
    note: '36 主题、模板驱动，好看且泛用——默认推荐',
  },
  {
    id: 'frontend-slides',
    name: 'frontend-slides',
    repo: 'https://github.com/zarazhangrui/frontend-slides',
    license: 'MIT',
    note: '可把 PPTX 转成 HTML',
  },
  {
    id: 'guizang-ppt-skill',
    name: 'guizang-ppt-skill',
    repo: 'https://github.com/op7418/guizang-ppt-skill',
    license: 'AGPL',
    note: '杂志 / 瑞士版式，质量标杆（注意 AGPL 协议）',
  },
];

/** 在清单里按 id 找候选（引导卡选装 / 默认项查源用）。 */
export function findCuratedDeckSkill(id: string): CuratedDeckSkill | undefined {
  return CURATED_DECK_SKILLS.find((s) => s.id === id);
}
