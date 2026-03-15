---
name: add-matrix
description: Add Matrix as a channel. Fully self-hosted — all traffic stays on local network (e.g., Tailscale). Uses matrix-js-sdk to connect to a Synapse/Dendrite homeserver. No public internet required.
---

# Add Matrix Channel

This skill adds Matrix as a messaging channel for NanoClaw. Matrix is fully self-hosted — all message traffic stays on the local network (Tailscale, LAN, etc.). No data leaves the network.

Unlike Telegram/WhatsApp/Slack which route through third-party cloud servers, Matrix connects directly to a homeserver you control.

## Trigger

"add matrix", "matrix channel", "element", "synapse"

## Prerequisites

The user must have a Matrix homeserver (Synapse, Dendrite, or Conduit) running and accessible from this machine. NanoClaw does NOT set up the homeserver — that's infrastructure (Ansible, Docker Compose, etc.).

The user needs:
1. **Homeserver URL** — e.g., `http://100.64.0.5:8008` (Tailscale IP) or `http://localhost:8008`
2. **Bot account** — a Matrix user for the bot (e.g., `@andie:matrix.local`)
3. **Access token** — for the bot account

If the user doesn't have an access token, help them get one:

```bash
# Register the bot user (if not already created)
# Via Synapse admin API or register_new_matrix_user CLI

# Get an access token by logging in:
curl -s -X POST '<HOMESERVER_URL>/_matrix/client/v3/login' \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","user":"<BOT_USERNAME>","password":"<BOT_PASSWORD>"}' \
  | jq -r '.access_token'
```

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/matrix.ts` exists. If it does, skip to Phase 3 (Configure).

### Verify homeserver connectivity

Ask the user for their homeserver URL, then verify:

```bash
curl -s <HOMESERVER_URL>/_matrix/client/versions
```

This should return a JSON object with supported versions.

## Phase 2: Apply Code Changes

### 2.1 Install matrix-js-sdk

```bash
npm install matrix-js-sdk
```

### 2.2 Create src/channels/matrix.ts

Create the Matrix channel implementation following the exact same pattern as `src/channels/telegram.ts`.

**JID format:** `mx:<room-id>` (e.g., `mx:!abc123def:matrix.local`)

```typescript
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
          logger.error({ roomId: member.roomId, err }, 'Failed to auto-join Matrix room');
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
      // @ts-expect-error — _initialSyncComplete is internal but reliable
      if (!this.client?._initialSyncComplete) return;

      const roomId = event.getRoomId();
      if (!roomId) return;

      const chatJid = `mx:${roomId}`;
      const content = event.getContent();
      const msgtype = content.msgtype;
      const timestamp = new Date(event.getTs()).toISOString();
      const senderName = room?.getMember(senderId!)?.name || senderId || 'Unknown';
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
        logger.debug({ chatJid, roomName }, 'Message from unregistered Matrix room');
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
          const userId = this.client!.getUserId();
          logger.info({ userId }, 'Matrix client connected');
          console.log(`\n  Matrix bot: ${userId}`);
          console.log(`  Homeserver: ${this.homeserverUrl}`);
          console.log(`  Invite the bot to a room, then use its room ID to register\n`);
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

      // Matrix has a practical ~65KB limit per event, but split at 4096
      // for readability (same as Telegram)
      const MAX_LENGTH = 4096;
      const chunks =
        text.length <= MAX_LENGTH
          ? [text]
          : text.match(new RegExp(`.{1,${MAX_LENGTH}}`, 'gs')) || [text];

      for (const chunk of chunks) {
        await this.client.sendMessage(roomId, {
          msgtype: MsgType.Text,
          body: chunk,
          // Send HTML formatted version for clients that support it
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
    logger.warn('Matrix: MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, or MATRIX_BOT_USER_ID not set');
    return null;
  }
  return new MatrixChannel(homeserverUrl, accessToken, botUserId, opts);
});
```

**Important implementation notes:**
- `initialSyncLimit: 0` — don't process old messages on startup
- The `_initialSyncComplete` check prevents replaying history on reconnect
- Auto-joins rooms on invite — the bot just needs to be invited
- Supports typing indicators via `sendTyping()`
- Implements `syncGroups()` to discover joined rooms
- Handles non-text messages (images, files, etc.) with placeholders like Telegram
- Mention detection: checks if the bot's display name appears in the message and prepends the trigger

### 2.3 Update barrel import

Add to `src/channels/index.ts`:

```typescript
// matrix
import './matrix.js';
```

Add it in alphabetical order (before the `// slack` comment).

### 2.4 Add .env.example entries

Append to `.env.example`:

```bash
# Matrix (self-hosted — all traffic stays on local network)
# MATRIX_HOMESERVER_URL="http://100.64.0.5:8008"
# MATRIX_ACCESS_TOKEN="syt_..."
# MATRIX_BOT_USER_ID="@andie:matrix.local"
```

### 2.5 Build and test

```bash
npm run build
npx vitest run
```

Fix any TypeScript errors. The `matrix-js-sdk` has comprehensive type definitions but some internal properties may need `@ts-expect-error` comments.

**Common issue:** `matrix-js-sdk` may emit TypeScript warnings about ESM/CJS interop. If the default import fails, try:
```typescript
import * as sdk from 'matrix-js-sdk';
```
and adjust `sdk.createClient()` accordingly. Check the actual export shape after install.

## Phase 3: Configure

### Set credentials in .env

Ask the user for their Matrix credentials and add to `.env`:

```bash
MATRIX_HOMESERVER_URL="http://<tailscale-ip-or-localhost>:8008"
MATRIX_ACCESS_TOKEN="<access-token>"
MATRIX_BOT_USER_ID="@<bot-username>:<server-name>"
```

### Restart the service

```bash
# Linux (systemd)
systemctl --user restart nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Register Rooms

### Get room IDs

The bot auto-joins rooms when invited. To find a room's ID:
- In Element: Room Settings > Advanced > Internal Room ID
- The format is `!abc123def:matrix.local`

### Register a room

```bash
npx tsx setup/index.ts --step register \
  --jid "mx:!abc123def:matrix.local" \
  --name "My Room" \
  --folder "matrix_my-room" \
  --trigger "@Andie" \
  --channel matrix
```

Add `--network` and `--proxy` flags for network isolation if needed.

## Phase 5: Verify

Tell the user:

> Matrix channel is connected. Invite the bot to a room in Element, then register the room with its ID.
>
> All traffic stays on your local network — no messages leave Tailscale.
>
> To test, send a message mentioning the trigger word in a registered room.

### Check logs if needed

```bash
journalctl --user -u nanoclaw -f | grep -i matrix
```

Look for:
- `Matrix client connected` — successful connection
- `Matrix message stored` — inbound message received
- `Matrix message sent` — outbound reply delivered

## Troubleshooting

### "MATRIX_HOMESERVER_URL not set"

Add all three env vars to `.env`: `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN`, `MATRIX_BOT_USER_ID`.

### Bot doesn't respond

1. Check the bot is invited to the room: invite `@bot:server` from Element
2. Verify the room is registered: check the JID matches `mx:<room-id>` exactly
3. Ensure the trigger word is in the message

### "Failed to auto-join Matrix room"

The bot account may not have permission to join. Check the room's invite settings, or manually join the bot to the room via admin API.

### Sync issues / duplicate messages

The `initialSyncLimit: 0` setting prevents old message replay. If messages are duplicating, check that only one NanoClaw instance is running.
