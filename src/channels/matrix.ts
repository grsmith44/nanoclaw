import sdk, {
  ClientEvent,
  MatrixClient,
  MsgType,
  RoomEvent,
  RoomMemberEvent,
} from 'matrix-js-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class MatrixChannel implements Channel {
  name = 'matrix';

  private client: MatrixClient | null = null;
  private opts: MatrixChannelOpts;
  private homeserverUrl: string;
  private accessToken: string;
  private botUserId: string;
  private initialSyncDone = false;

  constructor(
    homeserverUrl: string,
    accessToken: string,
    botUserId: string,
    opts: MatrixChannelOpts,
  ) {
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
    this.botUserId = botUserId;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = sdk.createClient({
      baseUrl: this.homeserverUrl,
      accessToken: this.accessToken,
      userId: this.botUserId,
    });

    // Auto-join rooms when invited
    this.client.on(RoomMemberEvent.Membership, (event, member) => {
      if (member.membership === 'invite' && member.userId === this.botUserId) {
        this.client!.joinRoom(member.roomId).catch((err) => {
          logger.error(
            { roomId: member.roomId, err },
            'Failed to auto-join Matrix room',
          );
        });
      }
    });

    // Handle incoming messages
    this.client.on(RoomEvent.Timeline, (event, room) => {
      // Ignore non-message events
      if (event.getType() !== 'm.room.message') return;

      // Ignore own messages
      const senderId = event.getSender();
      if (senderId === this.botUserId) return;

      // Ignore old messages from before initial sync
      if (!this.initialSyncDone) return;

      const roomId = event.getRoomId();
      if (!roomId) return;

      const chatJid = `mx:${roomId}`;
      const content = event.getContent();
      const msgtype = content.msgtype;
      const timestamp = new Date(event.getTs()).toISOString();
      const senderName =
        room?.getMember(senderId!)?.name || senderId || 'Unknown';
      const sender = senderId || '';
      const msgId = event.getId() || Date.now().toString();

      // Determine room name
      const roomName = room?.name || chatJid;
      const isGroup = (room?.getJoinedMemberCount() || 0) > 2;

      // Store chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, roomName, 'matrix', isGroup);

      // Only deliver for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, roomName },
          'Message from unregistered Matrix room',
        );
        return;
      }

      // Build message content based on type
      let messageText: string;
      switch (msgtype) {
        case MsgType.Text:
        case MsgType.Notice:
          messageText = content.body || '';
          break;
        case MsgType.Image:
          messageText = `[Image]${content.body ? ` ${content.body}` : ''}`;
          break;
        case MsgType.Video:
          messageText = `[Video]${content.body ? ` ${content.body}` : ''}`;
          break;
        case MsgType.Audio:
          messageText = `[Audio]${content.body ? ` ${content.body}` : ''}`;
          break;
        case MsgType.File:
          messageText = `[File: ${content.body || 'file'}]`;
          break;
        default:
          messageText = `[${msgtype || 'Unknown'}]`;
      }

      // Check for @mention of the bot display name and prepend trigger if needed
      if (
        messageText.toLowerCase().includes(ASSISTANT_NAME.toLowerCase()) &&
        !TRIGGER_PATTERN.test(messageText)
      ) {
        messageText = `@${ASSISTANT_NAME} ${messageText}`;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: messageText,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, roomName, sender: senderName },
        'Matrix message stored',
      );
    });

    // Start the client
    await this.client.startClient({ initialSyncLimit: 0 });

    // Wait for initial sync
    await new Promise<void>((resolve) => {
      this.client!.once(ClientEvent.Sync, (state) => {
        if (state === 'PREPARED') {
          this.initialSyncDone = true;
          const userId = this.client!.getUserId();
          logger.info({ userId }, 'Matrix client connected');
          console.log(`\n  Matrix bot: ${userId}`);
          console.log(`  Homeserver: ${this.homeserverUrl}`);
          console.log(
            `  Invite the bot to a room, then use its room ID to register\n`,
          );
          resolve();
        }
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Matrix client not initialized');
      return;
    }

    try {
      const roomId = jid.replace(/^mx:/, '');

      // Split at 4096 for readability (same as Telegram)
      const MAX_LENGTH = 4096;
      const chunks =
        text.length <= MAX_LENGTH
          ? [text]
          : text.match(new RegExp(`.{1,${MAX_LENGTH}}`, 'gs')) || [text];

      for (const chunk of chunks) {
        await this.client.sendMessage(roomId, {
          msgtype: MsgType.Text,
          body: chunk,
          format: 'org.matrix.custom.html',
          formatted_body: chunk,
        });
      }

      logger.info({ jid, length: text.length }, 'Matrix message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Matrix message');
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('mx:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.stopClient();
      this.client = null;
      logger.info('Matrix client stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    try {
      const roomId = jid.replace(/^mx:/, '');
      await this.client.sendTyping(roomId, isTyping, isTyping ? 30000 : 0);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Matrix typing indicator');
    }
  }

  async syncGroups(): Promise<void> {
    if (!this.client) return;
    const rooms = this.client.getRooms();
    for (const room of rooms) {
      const chatJid = `mx:${room.roomId}`;
      const isGroup = (room.getJoinedMemberCount() || 0) > 2;
      this.opts.onChatMetadata(
        chatJid,
        new Date().toISOString(),
        room.name || room.roomId,
        'matrix',
        isGroup,
      );
    }
  }
}

registerChannel('matrix', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'MATRIX_HOMESERVER_URL',
    'MATRIX_ACCESS_TOKEN',
    'MATRIX_BOT_USER_ID',
  ]);
  const homeserverUrl =
    process.env.MATRIX_HOMESERVER_URL || envVars.MATRIX_HOMESERVER_URL || '';
  const accessToken =
    process.env.MATRIX_ACCESS_TOKEN || envVars.MATRIX_ACCESS_TOKEN || '';
  const botUserId =
    process.env.MATRIX_BOT_USER_ID || envVars.MATRIX_BOT_USER_ID || '';

  if (!homeserverUrl || !accessToken || !botUserId) {
    logger.warn(
      'Matrix: MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, or MATRIX_BOT_USER_ID not set',
    );
    return null;
  }
  return new MatrixChannel(homeserverUrl, accessToken, botUserId, opts);
});
