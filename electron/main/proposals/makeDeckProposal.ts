/**
 * Deck 模块（v1）：构造 DeckCreateProposal 的辅助。
 * 由 agentTools/proposeDeck.ts 和未来 ws/router 直接触发路径调用。
 */
import type { DeckCreateProposal } from '@shared/types';
import { newProposalId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';

export function buildDeckCreateProposal(args: {
  conversationId: string;
  deckName: string;
  targetProjectId: string | null;
  deckSkillId: string;
  brief: string;
  sizeHint: string;
  etaHint?: string;
  narrative: string;
  autoGenerate: boolean;
}): DeckCreateProposal {
  return {
    kind: 'deck.create',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: `新建演示稿 · ${args.deckName}`,
    description: args.brief,
    createdAt: Date.now(),
    deckName: args.deckName,
    targetProjectId: args.targetProjectId,
    deckSkillId: args.deckSkillId,
    brief: args.brief,
    sizeHint: args.sizeHint,
    etaHint: args.etaHint,
    narrative: args.narrative,
    autoGenerate: args.autoGenerate,
  };
}
