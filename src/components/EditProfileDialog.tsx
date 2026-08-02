/**
 * 编辑分身：你 + Twin 双方的头像和名字
 *
 * 设计要点：
 *  - modal 居中，沿用项目 dialog 容器样式
 *  - 两个 section（你 / Twin），各含头像（图片 + 上传）和名字（input）
 *  - 头像选择 → 走 AvatarCropDialog 拿到 PNG blob → 暂存到 state，不立即上传
 *  - 点保存：
 *      a. user 端：一次 user.profile.update 把头像 base64 + 名字原子提交
 *      b. Twin 端：先 agents.avatar.upload（如改了头像），再 agents.update（如改了名字）
 *      Twin 端两步非原子，本期不收紧
 *  - 两级守门：
 *      canSave 管"能点否"（名字合法 + 数据加载完毕）；
 *      userChanged / twinChanged 管"要发请求否"（基于 diff）。
 *      无改动时点保存 = 仅关闭（按钮目的是 commit 表单，不是 commit diff）
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { X, Upload } from 'lucide-react';
import { useUserProfileStore } from '@/stores/userProfileStore';
import { useAgentStore } from '@/stores/agentStore';
import { resolveOruName } from '@/lib/oruName';
import { wsClient } from '@/lib/ws';
import { AvatarCropDialog } from './AvatarCropDialog';
import {
  validateAvatarFile,
  blobToBase64,
  AvatarValidationError,
  uploadAgentAvatar,
} from '@/lib/avatarUpload';

type Props = {
  onClose: () => void;
};

const NAME_MIN = 1;
const NAME_MAX = 20;

type AvatarState = {
  blob: Blob | null;        // 用户上传了新图（未保存）
  serverPath: string | null; // 当前服务端值（fallback）
};

function previewSrc(s: AvatarState, blobUrl: string | null): string | null {
  if (blobUrl) return blobUrl;
  if (s.serverPath) return `oru-avatar://local${encodeURI(s.serverPath)}`;
  return null;
}

function useBlobUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

function validateName(name: string, t: TFunction): string | null {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN) return t('nameEmpty');
  if (trimmed.length > NAME_MAX) return t('nameTooLong', { max: NAME_MAX });
  return null;
}

export function EditProfileDialog({ onClose }: Props) {
  const { t } = useTranslation('profile');
  const profile = useUserProfileStore((s) => s.profile);
  const updateProfile = useUserProfileStore((s) => s.update);
  const activeAgent = useAgentStore((s) =>
    s.agents.find((a) => a.id === s.activeAgentId) ?? null,
  );
  const oruName = resolveOruName(activeAgent?.name); // 称呼收敛：标题/名字占位接个体名（无名回落 Oru）

  // user state
  const [userName, setUserName] = useState(profile?.name ?? '');
  const [userAvatar, setUserAvatar] = useState<AvatarState>({
    blob: null,
    serverPath: profile?.avatarPath ?? null,
  });

  // twin state
  const [twinName, setTwinName] = useState(activeAgent?.name ?? '');
  const [twinAvatar, setTwinAvatar] = useState<AvatarState>({
    blob: null,
    serverPath: activeAgent?.avatarPath ?? null,
  });

  // 哪个 section 在选文件（决定文件确认后写到哪个 avatar state）
  const [pickingFor, setPickingFor] = useState<null | 'user' | 'twin'>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // setSaving 是异步的；同 tick 双击 saving state 还没翻起来。用 ref 做硬阻拦。
  const savingRef = useRef(false);

  const userBlobUrl = useBlobUrl(userAvatar.blob);
  const twinBlobUrl = useBlobUrl(twinAvatar.blob);

  const userTrimmed = userName.trim();
  const twinTrimmed = twinName.trim();
  const userNameErr = validateName(userName, t);
  const twinNameErr = validateName(twinName, t);

  const userChanged =
    profile !== null &&
    (userTrimmed !== profile.name.trim() || userAvatar.blob !== null);
  const twinChanged =
    activeAgent !== null &&
    (twinTrimmed !== (activeAgent.name ?? '').trim() || twinAvatar.blob !== null);

  const canSave =
    profile !== null &&
    activeAgent !== null &&
    !userNameErr &&
    !twinNameErr &&
    !saving;

  const onPickFile = (target: 'user' | 'twin') => {
    setPickingFor(target);
    fileInputRef.current?.click();
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      validateAvatarFile(f);
      setPickedFile(f);
    } catch (err) {
      if (err instanceof AvatarValidationError) {
        setError(err.message);
      } else {
        setError(t('pickFileFailed'));
      }
    }
  };

  const onCropConfirm = (blob: Blob) => {
    if (pickingFor === 'user') {
      setUserAvatar({ ...userAvatar, blob });
    } else if (pickingFor === 'twin') {
      setTwinAvatar({ ...twinAvatar, blob });
    }
    setPickedFile(null);
    setPickingFor(null);
    setError(null);
  };

  const onSave = async () => {
    if (!canSave || !profile || !activeAgent) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      // ─── user 端：一次 user.profile.update 原子提交（含可选头像 base64）───
      if (userChanged) {
        const patch: { name?: string } = {};
        if (userTrimmed !== profile.name.trim()) patch.name = userTrimmed;
        const newAvatarBase64Png = userAvatar.blob ? await blobToBase64(userAvatar.blob) : undefined;
        await updateProfile({ patch, newAvatarBase64Png });
      }

      // ─── Twin 端：头像和名字两步（agents.avatar.upload + agents.update）───
      if (twinChanged) {
        if (twinAvatar.blob) {
          await uploadAgentAvatar(activeAgent.id, twinAvatar.blob);
        }
        if (twinTrimmed !== (activeAgent.name ?? '').trim()) {
          await wsClient.request({
            type: 'agents.update',
            agentId: activeAgent.id,
            patch: { name: twinTrimmed },
          });
        }
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const renderSection = (
    title: string,
    initialFallback: string,
    nameValue: string,
    onNameChange: (v: string) => void,
    nameErr: string | null,
    avatar: AvatarState,
    blobUrl: string | null,
    target: 'user' | 'twin',
  ) => {
    const trimmedName = nameValue.trim();
    const src = previewSrc(avatar, blobUrl);
    return (
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-text-tertiary">
          {title}
        </h3>
        <div className="flex items-start gap-4">
          <div
            className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full"
            style={{ background: 'var(--avatar-default-bg, #e8d5c4)' }}
          >
            {src ? (
              <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
            ) : (
              <span
                className="font-serif font-semibold leading-none text-text-primary"
                style={{ fontSize: 28 }}
              >
                {(trimmedName || initialFallback).charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex flex-1 flex-col gap-2">
            <button
              type="button"
              onClick={() => onPickFile(target)}
              className="inline-flex w-fit items-center gap-1 rounded border border-border bg-canvas px-2 py-1 text-xs text-text-primary hover:bg-hover"
            >
              <Upload size={11} strokeWidth={1.5} />
              {t('changeImage')}
            </button>
            <input
              type="text"
              value={nameValue}
              onChange={(e) => onNameChange(e.target.value)}
              maxLength={NAME_MAX + 5}
              className="w-full rounded border border-border bg-canvas px-2 py-1 text-sm text-text-primary outline-none focus:border-accent"
              placeholder={target === 'user' ? t('userNamePlaceholder') : t('twinNamePlaceholder', { name: oruName })}
            />
            {nameErr && trimmedName !== '' ? (
              <div className="text-[11px] text-danger">{nameErr}</div>
            ) : null}
          </div>
        </div>
      </section>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="flex w-[440px] max-w-[92vw] flex-col rounded-lg border border-border bg-elevated shadow-pop">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-medium text-text-primary">{t('title', { name: oruName })}</span>
            <button
              type="button"
              onClick={onClose}
              className="text-text-tertiary hover:text-text-secondary"
              aria-label={t('common:close')}
            >
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>

          <div className="flex flex-col gap-5 px-5 py-5">
            {renderSection(
              t('user'),
              'Y',
              userName,
              setUserName,
              userNameErr,
              userAvatar,
              userBlobUrl,
              'user',
            )}
            <div className="border-t border-border" />
            {renderSection(
              oruName,
              oruName,
              twinName,
              setTwinName,
              twinNameErr,
              twinAvatar,
              twinBlobUrl,
              'twin',
            )}
            {error ? <div className="text-xs text-danger">{error}</div> : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border bg-canvas px-3 py-1.5 text-sm text-text-secondary hover:bg-hover"
            >
              {t('common:cancel')}
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!canSave}
              className="rounded bg-accent px-3 py-1.5 text-sm disabled:opacity-40"
              style={{ color: 'var(--accent-fg, white)' }}
            >
              {saving ? t('common:saving') : t('common:save')}
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={onFileChange}
          />
        </div>
      </div>

      {pickedFile ? (
        <AvatarCropDialog
          file={pickedFile}
          onConfirm={onCropConfirm}
          onCancel={() => {
            setPickedFile(null);
            setPickingFor(null);
          }}
        />
      ) : null}
    </>
  );
}
