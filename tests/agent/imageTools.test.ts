/**
 * 图片工具纯函数单测（任务 3 §8）：
 *  - image_search 入参校验 + 候选清单文案（序号/尺寸/源/contentUrl、与 images 同序、不含描述）
 *  - download_image 入参校验 + 文件名净化（去 querystring/fragment、非法字符、缺后缀补实测、空 dest）
 *  - 引擎响应 → 统一 ImageResultItem map（博查/Tavily 各喂 fixture，不打真 API）
 *
 * 解码/网络/落盘在 electron smoke 与集成 smoke 里验，这里只覆盖纯函数。
 */
import { describe, it, expect } from 'vitest';
import {
  parseImageSearchInput,
  formatCandidatesText,
  hostOf,
} from '../../electron/main/agent/agentTools/imageSearchInput';
import {
  parseDownloadInput,
  finalizeFilename,
  relImagePath,
} from '../../electron/main/agent/agentTools/downloadImageInput';
import { mapBochaImages } from '../../electron/main/search/engines/bocha';
import { mapTavilyImages } from '../../electron/main/search/engines/tavily';

describe('parseImageSearchInput', () => {
  it('空 query → 报错', () => {
    expect('error' in parseImageSearchInput({})).toBe(true);
    expect('error' in parseImageSearchInput({ query: '   ' })).toBe(true);
  });
  it('合法 query → trim', () => {
    const r = parseImageSearchInput({ query: '  团队协作  ' });
    expect(r).toEqual({ query: '团队协作' });
  });
});

describe('formatCandidatesText', () => {
  const cands = [
    { contentUrl: 'https://a.com/1.jpg', sourceUrl: 'https://site.com/p', width: 1920, height: 1080 },
    { contentUrl: 'https://b.com/2.png', sourceUrl: undefined, width: undefined, height: undefined },
  ];
  it('序号从 1、含尺寸/源 host/contentUrl，且不含描述', () => {
    const t = formatCandidatesText('q', 'bocha', cands);
    expect(t).toContain('[1] 1920×1080 · 源 site.com · contentUrl=https://a.com/1.jpg');
    expect(t).toContain('[2] 尺寸未知 · 源 ? · contentUrl=https://b.com/2.png');
    expect(t).toContain('看到 2 张候选');
  });
  it('条数与候选数一致（与 images 同序的保证）', () => {
    const lines = formatCandidatesText('q', 'tavily', cands)
      .split('\n')
      .filter((l) => /^\[\d+\]/.test(l));
    expect(lines.length).toBe(cands.length);
  });
});

describe('hostOf', () => {
  it('解析 host；坏 URL / 空 → ?', () => {
    expect(hostOf('https://x.com/a')).toBe('x.com');
    expect(hostOf('not a url')).toBe('?');
    expect(hostOf(undefined)).toBe('?');
  });
});

describe('parseDownloadInput', () => {
  it('缺 url / dest → 报错', () => {
    expect('error' in parseDownloadInput({ dest: '/d/images/a.jpg' })).toBe(true);
    expect('error' in parseDownloadInput({ url: 'https://x/a.jpg' })).toBe(true);
  });
  it('合法 → trim', () => {
    expect(parseDownloadInput({ url: ' https://x/a.jpg ', dest: ' /d/images/a.jpg ' })).toEqual({
      url: 'https://x/a.jpg',
      dest: '/d/images/a.jpg',
    });
  });
});

describe('finalizeFilename', () => {
  it('去 querystring 与 fragment', () => {
    expect(finalizeFilename('/d/images/a.png?v=1#x', 'png')).toBe('a.png');
  });
  it('空格/非法字符 → -，合并连续 -', () => {
    expect(finalizeFilename('/d/images/a b  c.jpg', 'jpg')).toBe('a-b-c.jpg');
    // basename 已剥掉子目录段，只净化最后一段
    expect(finalizeFilename('/d/images/b:c*.png', 'png')).toBe('b-c.png');
  });
  it('缺/非图片后缀 → 用实测 mimeExt（非图片后缀被替换，不叠加）', () => {
    expect(finalizeFilename('/d/images/hero', 'webp')).toBe('hero.webp');
    expect(finalizeFilename('/d/images/hero.txt', 'png')).toBe('hero.png');
  });
  it('合法图片后缀保留（即便与实测不同——不强行改名）', () => {
    expect(finalizeFilename('/d/images/hero.jpg', 'png')).toBe('hero.jpg');
  });
  it('stem 净化后为空 → image 兜底', () => {
    expect(finalizeFilename('/d/images/---.png', 'png')).toBe('image.png');
  });
});

describe('relImagePath', () => {
  it('取父目录名 + 最终名（含去重后的 -2）', () => {
    expect(relImagePath('/proj/deck/images/hero.jpg', 'hero-2.jpg')).toBe('images/hero-2.jpg');
  });
});

describe('mapBochaImages', () => {
  it('Bing 式 data.images.value[] → 统一结构；无 contentUrl 回落 thumbnailUrl', () => {
    const raw = {
      data: {
        images: {
          value: [
            {
              thumbnailUrl: 'https://t/1.jpg',
              contentUrl: 'https://c/1.jpg',
              hostPageUrl: 'https://src/p',
              name: 'desc',
              width: 800,
              height: 600,
            },
            { thumbnailUrl: 'https://t/2.jpg' }, // 无 contentUrl → 回落 thumbnailUrl
            { name: 'no-url' }, // 两者皆无 → 丢弃
          ],
        },
      },
    };
    const out = mapBochaImages(raw);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({
      thumbnailUrl: 'https://t/1.jpg',
      contentUrl: 'https://c/1.jpg',
      sourceUrl: 'https://src/p',
      description: 'desc',
      width: 800,
      height: 600,
    });
    expect(out[1].contentUrl).toBe('https://t/2.jpg');
  });
  it('无 images 字段 → 空数组（schema 不符也不炸）', () => {
    expect(mapBochaImages({ data: { webPages: { value: [] } } })).toEqual([]);
    expect(mapBochaImages({})).toEqual([]);
  });
});

describe('mapTavilyImages', () => {
  it('顶层 images[] → thumbnailUrl=contentUrl=url，带 description', () => {
    const out = mapTavilyImages({
      images: [
        { url: 'https://i/1.jpg', description: 'a cat' },
        { description: 'no url' }, // 无 url → 丢弃
      ],
    });
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({
      thumbnailUrl: 'https://i/1.jpg',
      contentUrl: 'https://i/1.jpg',
      description: 'a cat',
    });
  });
  it('无 images → 空数组', () => {
    expect(mapTavilyImages({ results: [] })).toEqual([]);
  });
});
