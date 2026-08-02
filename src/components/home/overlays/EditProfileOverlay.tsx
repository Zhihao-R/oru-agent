/**
 * 编辑资料浮层（A5，420px）——双称呼下划线输入 + 计数 N/20，点头像直接进裁剪。
 * 保存仍走 user.profile.update / agents.avatar.upload + agents.update；AvatarCropDialog 沿用。
 * 保存逻辑与既有 EditProfileDialog 同源（同一套 avatarUpload lib），仅换设计稿版式。
 */
import { useEffect, useRef, useState, type ChangeEvent, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { useUserProfileStore } from '@/stores/userProfileStore';
import { useAgentStore } from '@/stores/agentStore';
import { resolveOruName } from '@/lib/oruName';
import { wsClient } from '@/lib/ws';
import { AvatarCropDialog } from '@/components/AvatarCropDialog';
import {
  validateAvatarFile,
  blobToBase64,
  AvatarValidationError,
  uploadAgentAvatar,
} from '@/lib/avatarUpload';
import { HomeAvatar } from '../HomeAvatar';
import { Overlay } from './Overlay';

const NAME_MAX = 20;

type AvatarState = { blob: Blob | null; serverPath: string | null };

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

export function EditProfileOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('home');
  const { t: tp } = useTranslation('profile');
  const profile = useUserProfileStore((s) => s.profile);
  const updateProfile = useUserProfileStore((s) => s.update);
  const activeAgent = useAgentStore((s) => s.agents.find((a) => a.id === s.activeAgentId) ?? null);
  const oruName = resolveOruName(activeAgent?.name);

  const [userName, setUserName] = useState(profile?.name ?? '');
  const [userAvatar, setUserAvatar] = useState<AvatarState>({ blob: null, serverPath: profile?.avatarPath ?? null });
  const [twinName, setTwinName] = useState(activeAgent?.name ?? '');
  const [twinAvatar, setTwinAvatar] = useState<AvatarState>({ blob: null, serverPath: activeAgent?.avatarPath ?? null });

  const [pickingFor, setPickingFor] = useState<null | 'user' | 'twin'>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  const userBlobUrl = useBlobUrl(userAvatar.blob);
  const twinBlobUrl = useBlobUrl(twinAvatar.blob);

  const userTrimmed = userName.trim();
  const twinTrimmed = twinName.trim();
  const userValid = userTrimmed.length >= 1 && [...userTrimmed].length <= NAME_MAX;
  const twinValid = twinTrimmed.length >= 1 && [...twinTrimmed].length <= NAME_MAX;

  const userChanged = profile !== null && (userTrimmed !== profile.name.trim() || userAvatar.blob !== null);
  const twinChanged = activeAgent !== null && (twinTrimmed !== (activeAgent.name ?? '').trim() || twinAvatar.blob !== null);
  const canSave = profile !== null && activeAgent !== null && userValid && twinValid && !saving;

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      validateAvatarFile(f);
      setPickedFile(f);
    } catch (err) {
      setError(err instanceof AvatarValidationError ? err.message : tp('pickFileFailed'));
    }
  };

  const onCropConfirm = (blob: Blob) => {
    if (pickingFor === 'user') setUserAvatar((s) => ({ ...s, blob }));
    else if (pickingFor === 'twin') setTwinAvatar((s) => ({ ...s, blob }));
    setPickedFile(null);
    setPickingFor(null);
    setError(null);
  };

  const onSave = async () => {
    if (!canSave || !profile || !activeAgent || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (userChanged) {
        const patch: { name?: string } = {};
        if (userTrimmed !== profile.name.trim()) patch.name = userTrimmed;
        const newAvatarBase64Png = userAvatar.blob ? await blobToBase64(userAvatar.blob) : undefined;
        await updateProfile({ patch, newAvatarBase64Png });
      }
      if (twinChanged) {
        if (twinAvatar.blob) await uploadAgentAvatar(activeAgent.id, twinAvatar.blob);
        if (twinTrimmed !== (activeAgent.name ?? '').trim()) {
          await wsClient.request({ type: 'agents.update', agentId: activeAgent.id, patch: { name: twinTrimmed } });
        }
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tp('saveFailed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const previewPath = (a: AvatarState, blobUrl: string | null): string | null =>
    blobUrl ? null : a.serverPath;

  const openPicker = (target: 'user' | 'twin') => {
    setPickingFor(target);
    fileInputRef.current?.click();
  };

  return (
    <Overlay width={420} onClose={onClose}>
      <div className="px-[38px] pb-7 pt-[34px]">
        <div className="font-serif text-[19px] font-semibold tracking-[-0.01em] text-text-primary">
          {t('editProfile.title')}
        </div>

        <NameRow
          label={t('editProfile.yourName')}
          name={userName}
          setName={setUserName}
          avatarNode={
            <AvatarPickButton
              name={userName}
              variant="neutral"
              serverPath={previewPath(userAvatar, userBlobUrl)}
              blobUrl={userBlobUrl}
              onClick={() => openPicker('user')}
            />
          }
        />
        <NameRow
          label={t('editProfile.oruName')}
          name={twinName}
          setName={setTwinName}
          avatarNode={
            <AvatarPickButton
              name={twinName}
              variant="accent"
              serverPath={previewPath(twinAvatar, twinBlobUrl)}
              blobUrl={twinBlobUrl}
              onClick={() => openPicker('twin')}
            />
          }
        />

        <div className="mt-3 text-[11.5px] text-text-quaternary">{t('editProfile.hint')}</div>
        {error && <div className="mt-2 text-[11.5px] text-danger">{error}</div>}

        <div className="mt-[26px] flex items-baseline justify-end gap-6">
          <button type="button" onClick={onClose} className="text-[13px] text-text-tertiary hover:text-text-primary">
            {t('editProfile.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!canSave}
            className="border-b border-accent pb-px text-[13px] font-semibold text-accent-deep disabled:opacity-40"
          >
            {saving ? tp('common:saving') : t('editProfile.save')}
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={onFileChange}
      />
      {pickedFile && (
        <AvatarCropDialog
          file={pickedFile}
          onConfirm={onCropConfirm}
          onCancel={() => {
            setPickedFile(null);
            setPickingFor(null);
          }}
        />
      )}
    </Overlay>
  );
}

function NameRow({
  label,
  name,
  setName,
  avatarNode,
}: {
  label: string;
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  avatarNode: React.ReactNode;
}) {
  const { t } = useTranslation('home');
  const count = [...name.trim()].length;
  return (
    <div className="mt-[22px] flex items-end gap-[18px] first:mt-[26px]">
      {avatarNode}
      <div className="flex-1">
        <div className="font-mono text-[10px] tracking-[0.14em] text-text-quaternary">{label}</div>
        <div className="mt-0.5 flex items-baseline gap-2 border-b border-border-strong pb-1.5 pt-1.5 focus-within:border-accent-line">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX + 5}
            className="flex-1 bg-transparent text-[14px] text-text-primary outline-none"
          />
          <span className="font-mono text-[10px] text-text-quaternary">{t('editProfile.counter', { n: count })}</span>
        </div>
      </div>
    </div>
  );
}

function AvatarPickButton({
  name,
  variant,
  serverPath,
  blobUrl,
  onClick,
}: {
  name: string;
  variant: 'accent' | 'neutral';
  serverPath: string | null;
  blobUrl: string | null;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent">
      {blobUrl ? (
        <span className="inline-flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border border-border-strong">
          <img src={blobUrl} alt="" draggable={false} className="h-full w-full object-cover" />
        </span>
      ) : (
        <HomeAvatar name={name} avatarPath={serverPath} size={56} variant={variant} />
      )}
    </button>
  );
}
