/**
 * MCP 启停开关 —— 列表行末端和详情面板状态条都用同一个组件。
 *
 * 切换 onChange 走 mcp.update（不走 mcp.restart）—— mcp.restart 语义是「强制重启」，
 * 跟 toggle 的「我想启/停」是两件事。
 *
 * UI 委托给通用 Switch；这层只管业务（乐观更新 + spawning 中间态 + 失败回滚）。
 */
import { useTranslation } from 'react-i18next';
import { wsClient } from '@/lib/ws';
import { toastError } from '@/lib/toast';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMcpRuntimeStore } from '@/stores/mcpRuntimeStore';
import { Switch } from '@/components/ui/Switch';

export function McpToggle({
  serverId,
  enabled,
}: {
  serverId: string;
  enabled: boolean;
}) {
  const { t } = useTranslation('settings');
  const onChange = async (next: boolean) => {
    // 乐观更新本地 settings —— 后端 reply 会带新的 settings.state broadcast 同步
    const cur = useSettingsStore.getState().settings;
    const list = (cur.mcpServers ?? []).map((s) =>
      s.id === serverId ? { ...s, enabled: next } : s,
    );
    useSettingsStore.setState({ settings: { ...cur, mcpServers: list } });

    // off → on 时进入 spawning 中间态（色点立即变浅灰 + 旋转 ring；reply 落定后转真状态）
    if (next) {
      useMcpRuntimeStore.getState().markSpawning(serverId);
    }

    // 失败回滚乐观更新（保持后端真值）；spawning 也要清回 idle，
    // 否则色点会卡在"旋转浅灰"中间态直到下次 broadcast
    const rollback = (): void => {
      const c2 = useSettingsStore.getState().settings;
      const l2 = (c2.mcpServers ?? []).map((s) =>
        s.id === serverId ? { ...s, enabled: !next } : s,
      );
      useSettingsStore.setState({ settings: { ...c2, mcpServers: l2 } });
      if (next) {
        useMcpRuntimeStore.getState().upsert({ serverId, status: 'idle' });
      }
    };

    try {
      const res = await wsClient.request({
        type: 'mcp.update',
        serverId,
        patch: { enabled: next },
      });
      if (res.type === 'mcp.update.result' && res.ok) {
        // 消费 reply 落定运行时态（曾整个丢弃、注释承诺的 broadcast 从未存在——状态行
        // 永挂「正在启动…」，打磨 7）。与 McpDetailPanel onSave/onReconnect 同一模式。
        if (res.status !== undefined) {
          useMcpRuntimeStore.getState().upsert({
            serverId,
            status: res.status,
            toolCount: res.toolCount,
            lastError: res.message,
            circuitOpenUntil: res.circuitOpenUntil,
          });
        }
      } else {
        // reply ok:false 也是失败——回滚乐观 settings（曾不回滚，开关与真值背离）
        rollback();
        toastError(
          res.type === 'mcp.update.result'
            ? res.message ?? t('toast.mcpToggleFailed')
            : t('toast.mcpToggleFailed'),
        );
      }
    } catch (err) {
      rollback();
      console.warn('[mcp] toggle 失败', err);
      toastError(t('toast.mcpToggleFailed'));
    }
  };

  return (
    <Switch
      checked={enabled}
      onChange={(next) => void onChange(next)}
      ariaLabel={t('extensions.mcpToggleAria')}
    />
  );
}
