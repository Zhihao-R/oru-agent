import type { Config } from 'tailwindcss';

// 主题 token 色统一经 color-mix 暴露 <alpha-value>：让 bg-elevated/40 这类透明度修饰类
// 对 var() 颜色也能生成（裸 'var(--x)' 时 tailwind 生不出 /NN 类，会静默丢样式）。
// 无修饰时 calc(1 * 100%) 与原色完全等价。
const tokenColor = (cssVar: string) =>
  `color-mix(in srgb, var(${cssVar}) calc(<alpha-value> * 100%), transparent)`;

export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: tokenColor('--bg-canvas'),
        elevated: tokenColor('--bg-elevated'),
        sunken: tokenColor('--bg-sunken'),
        // 第二档下沉面：比 sunken 更浅的近白填充（输入框/tab/卡脚/微 hover），设计稿 --sunken2
        'sunken-2': tokenColor('--bg-sunken-2'),
        hover: tokenColor('--bg-hover'),
        border: tokenColor('--border-default'),
        'border-strong': tokenColor('--border-strong'),
        // 第三档边框：最强的实线（拖拽把手/空心圈/分隔强调），设计稿 --line3
        'border-heavy': tokenColor('--border-heavy'),
        'text-primary': tokenColor('--text-primary'),
        'text-secondary': tokenColor('--text-secondary'),
        'text-tertiary': tokenColor('--text-tertiary'),
        // 第四档文字：最弱的元信息（占位/计数/faint 标签/chevron），设计稿 --tx4
        'text-quaternary': tokenColor('--text-quaternary'),
        accent: tokenColor('--accent'),
        // 加深强调色：hover/pressed、链接、「由 X」脚注、open 按钮文字，设计稿 --ac-deep
        'accent-deep': tokenColor('--accent-deep'),
        'accent-soft': tokenColor('--accent-soft'),
        // 强调色描边/下划线（引用链接、选中描边淡态），设计稿 --ac-line（盘点第 5 条缺口正式收编）
        'accent-line': tokenColor('--accent-line'),
        // 聚焦亮灯边线：日间＝accent-line、夜间提亮（--lamp-line 日夜分流，勿直改 accent-line——它另有约 10 处消费）
        'lamp-line': tokenColor('--lamp-line'),
        // 聚焦环/拖放高亮专用预混透明度 token（历史上 /NN 对 var() 不生成时的产物，消费点多，保留）
        'accent-ring': tokenColor('--accent-ring'),
        // 画布色的毛玻璃衬底（悬浮条衬在滚动正文上），同上保留
        'canvas-glass': 'color-mix(in srgb, var(--bg-canvas) 90%, transparent)',
        // 实心 accent 底上的前景色（日间白、夜间墨），bg-accent 必配 text-accent-fg 而非 text-white
        'accent-fg': tokenColor('--accent-fg'),
        danger: tokenColor('--danger'),
        // 语义色 base/deep/soft 三件套：deep 供「同色文字压同色 soft 底」的 a11y 对比与 hover
        'danger-deep': tokenColor('--danger-deep'),
        'danger-soft': tokenColor('--danger-soft'),
        success: tokenColor('--success'),
        'success-deep': tokenColor('--success-deep'),
        'success-soft': tokenColor('--success-soft'),
        warn: tokenColor('--warn'),
        'warn-deep': tokenColor('--warn-deep'),
        'warn-soft': tokenColor('--warn-soft'),
        // 实心语义色底上的前景色（同 accent-fg 语义：日间白、夜间墨——夜间语义色提亮后白字对比塌）
        'danger-fg': tokenColor('--danger-fg'),
        'success-fg': tokenColor('--success-fg'),
        'warn-fg': tokenColor('--warn-fg'),
        // 随手评点浮层的反色 token（亮色主题重墨色、夜间反转，src/index.css 各主题逐项定义）
        'pop-bg': tokenColor('--pop-bg'),
        'pop-fg': tokenColor('--pop-fg'),
        'pop-fg-dim': tokenColor('--pop-fg-dim'),
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"Helvetica Neue"', 'system-ui', 'sans-serif'],
        mono: ['"SF Mono"', 'ui-monospace', 'Menlo', 'Monaco', 'monospace'],
        serif: ['"New York"', '"Source Serif Pro"', 'Georgia', 'serif'],
      },
      fontSize: {
        // 微字号：胶囊/eyebrow/badge/来源标注等最小一档（设计稿 10.5，收敛掉散落的 10/10.5）
        '2xs': ['10.5px', '14px'],
        xs: ['11px', '16px'],
        sm: ['12px', '18px'],
        base: ['13px', '20px'],
        md: ['14px', '22px'],
        lg: ['16px', '24px'],
        xl: ['18px', '28px'],
        '2xl': ['22px', '32px'],
      },
      borderRadius: {
        // 最小圆角：消息内小件（工具卡/命令块/芯片），设计稿 3px 硬朗感
        xs: '3px',
        sm: '4px',
        DEFAULT: '6px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
      boxShadow: {
        // 阴影随冷调色板改用冷墨 rgba(20,40,48)；soft = 活卡的微抬升（设计稿 0 1px 4px .08）
        soft: '0 1px 4px 0 rgba(20,40,48,0.08)',
        // 输入区聚焦：淡 accent 投影替代 2px 实心 ring（设计稿 composer 0 1px 4px rgba(27,158,107,.14)），
        // 预混 color-mix 随主题 accent 联动，配 border-accent-line 使用。
        // 拼接 --shadow-night（日间置空）：夜间聚焦/浮层不丢环境投影，消费点无感知
        focus: '0 1px 4px 0 color-mix(in srgb, var(--accent) 14%, transparent), var(--shadow-night)',
        // 夜间环境投影单用（非聚焦的浮起元素，如 composer 常态）；日间自动为空
        night: 'var(--shadow-night)',
        card: '0 4px 12px -2px rgba(20,40,48,0.10), 0 2px 4px -1px rgba(20,40,48,0.05)',
        pop: '0 18px 50px -18px rgba(20,40,48,0.32), 0 4px 12px -4px rgba(20,40,48,0.10)',
      },
    },
  },
  plugins: [],
} satisfies Config;
