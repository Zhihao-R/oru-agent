/**
 * 主页双头像（你 + Twin）+ 行星轨道切换 + 编辑入口
 *
 * 交互模型（双头像对称）：
 *  - hover **后位**头像（不论 user 还是 twin）→ 翻转前后，让被 hover 的那位上前
 *  - hover **前位**头像 → 旁边浮出编辑徽章；点徽章打开编辑对话框
 *  - swap 动画 0.55s，期间锁定不响应新触发
 *  - dialog 打开时父组件传 paused=true，呼吸暂停
 *
 * 几何 / keyframe / hover 反馈全部在 src/index.css 里以 .oru-pair* class 为前缀维护。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveOruName } from '@/lib/oruName';
import { initialOf } from '@/components/ui/Avatar';

type Props = {
  user: { name: string; avatarPath: string | null };
  twin: { name: string; avatarPath: string | null };
  /** 点编辑徽章触发 —— 不论是 user 还是 twin 在前都打开同一个编辑对话框 */
  onEdit: () => void;
  /** dialog 打开时传 true：暂停呼吸（避免对话框背后的视觉干扰） */
  paused?: boolean;
};

const SWAP_DURATION_MS = 550;

function avatarSrc(avatarPath: string | null): string | null {
  if (!avatarPath) return null;
  // 与 TwinAvatar 同协议：oru-avatar://local 是注册的自定义 protocol
  return `oru-avatar://local${encodeURI(avatarPath)}`;
}

export function AvatarPair({ user, twin, onEdit, paused = false }: Props) {
  const { t } = useTranslation('profile');
  const twinDisplay = resolveOruName(twin.name); // 称呼收敛：个体名 || Oru（替代旧 'Twin'/'T' 兜底）
  const [front, setFront] = useState<'user' | 'twin'>('user');
  // swapping !== null 即"动画中"，跟 busy 是同义；不再单独维护 busy ref
  const [swapping, setSwapping] = useState<null | 'user-to-twin' | 'twin-to-user'>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载清理
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // hover 后位头像 → 让该头像上前（前位的 hover 不响应，由 CSS :hover 显示编辑徽章）
  const swapTo = useCallback(
    (target: 'user' | 'twin') => {
      if (swapping) return;
      if (target === front) return; // 已经是前位，hover 不切换（让位给编辑徽章）
      setSwapping(front === 'user' ? 'user-to-twin' : 'twin-to-user');
      setFront(target);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setSwapping(null), SWAP_DURATION_MS);
    },
    [front, swapping],
  );

  const userSrc = avatarSrc(user.avatarPath);
  const twinSrc = avatarSrc(twin.avatarPath);

  return (
    <div
      className="oru-pair"
      data-front={front}
      data-swapping={swapping ?? undefined}
      data-paused={paused ? 'true' : undefined}
    >
      <div
        className="planet"
        data-id="user"
        data-front-self={front === 'user' ? 'true' : 'false'}
        onMouseEnter={() => swapTo('user')}
      >
        <div className="breathe">
          <div className="face user">
            {userSrc ? (
              <img src={userSrc} alt="" draggable={false} />
            ) : (
              <span className="initial">{initialOf(user.name, 'Y')}</span>
            )}
          </div>
          <button
            type="button"
            className="edit-badge"
            aria-label={t('editAria', { name: twinDisplay })}
            onClick={onEdit}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="13"
              height="13"
              aria-hidden
            >
              <path d="M11.5 2.5l2 2L5 13H3v-2z" />
            </svg>
          </button>
        </div>
      </div>

      <div
        className="planet"
        data-id="twin"
        data-front-self={front === 'twin' ? 'true' : 'false'}
        onMouseEnter={() => swapTo('twin')}
      >
        <div className="breathe">
          <div className="face twin">
            {twinSrc ? (
              <img src={twinSrc} alt="" draggable={false} />
            ) : (
              <span className="initial">{initialOf(twinDisplay, 'O')}</span>
            )}
          </div>
          <button
            type="button"
            className="edit-badge"
            aria-label={t('editAria', { name: twinDisplay })}
            onClick={onEdit}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="13"
              height="13"
              aria-hidden
            >
              <path d="M11.5 2.5l2 2L5 13H3v-2z" />
            </svg>
          </button>
        </div>
      </div>

      <div className="oru-pair-labels">
        <div>
          <div className="who">{user.name || t('user')}</div>
        </div>
        <div>
          <div className="who">{twinDisplay}</div>
        </div>
      </div>
    </div>
  );
}
