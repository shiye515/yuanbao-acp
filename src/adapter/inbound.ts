/**
 * Inbound adapter: convert Yuanbao push messages to ACP ContentBlock[].
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { IncomingMessage } from '../yuanbao/yuanbao-client.js';

export async function yuanbaoMessageToPrompt(
  msg: IncomingMessage,
): Promise<acp.ContentBlock[]> {
  const text = msg.text?.trim();
  if (text) {
    return [{ type: 'text', text }];
  }
  return [{ type: 'text', text: '[empty message]' }];
}

// Backward compatible alias for previous bridge code.
export const weixinMessageToPrompt = yuanbaoMessageToPrompt;
