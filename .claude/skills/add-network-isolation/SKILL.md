---
name: add-network-isolation
description: Add per-group Docker network assignment and proxy configuration so groups can be isolated onto dedicated internal networks with Squid proxies.
---

# Add Network Isolation

This skill adds per-group Docker network and HTTP proxy configuration. Groups can be assigned to pre-existing internal Docker networks (created by Ansible) with optional Squid proxy routing. Containers on these networks have no default internet route — traffic goes through the assigned proxy (or nowhere, for fully isolated groups).

Pre-created networks (by Ansible):
- `nanoclaw-researcher` (172.20.0.0/16) — Squid proxy at 172.20.0.2:3128
- `nanoclaw-operator` (172.21.0.0/16) — no proxy (no internet)
- `nanoclaw-coder` (172.22.0.0/16) — Squid proxy at 172.22.0.2:3128

## Trigger

"add network isolation", "configure per-group networks", "network isolation"

## Phase 1: Pre-flight

### Check if already applied

Read `src/types.ts` and look for `dockerNetwork` in the `ContainerConfig` interface. If it already exists, tell the user the skill is already applied and skip to Phase 4 (Verify).

### Read current source

Read these files before making any changes:

1. `src/types.ts` — find the `ContainerConfig` interface
2. `src/container-runner.ts` — find `buildContainerArgs()` function and `runContainerAgent()` call site
3. `setup/register.ts` — find `parseArgs()` and `setRegisteredGroup()` call
4. `container/agent-runner/src/ipc-mcp-stdio.ts` — find the `register_group` tool definition

## Phase 2: Apply Code Changes

### 2.1 Extend ContainerConfig in src/types.ts

Add two new optional fields to the existing `ContainerConfig` interface:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  dockerNetwork?: string; // Docker network name (e.g., "nanoclaw-researcher")
  httpProxy?: string; // HTTP proxy URL (e.g., "http://172.20.0.2:3128")
}
```

### 2.2 Modify buildContainerArgs() in src/container-runner.ts

**a) Change the function signature** to accept the group:

```typescript
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  group: RegisteredGroup,
): string[] {
```

**b) Add network flag** — after the `--name` argument line (the `args` declaration), add:

```typescript
  if (group.containerConfig?.dockerNetwork) {
    args.push('--network', group.containerConfig.dockerNetwork);
  }
```

**c) Add proxy env vars** — after the `TZ` environment variable line, add:

```typescript
  if (group.containerConfig?.httpProxy) {
    args.push('-e', `HTTP_PROXY=${group.containerConfig.httpProxy}`);
    args.push('-e', `HTTPS_PROXY=${group.containerConfig.httpProxy}`);
    args.push('-e', 'NO_PROXY=localhost,127.0.0.1');
  }
```

**d) Update the call site** — in `runContainerAgent()`, find the line:

```typescript
  const containerArgs = buildContainerArgs(mounts, containerName);
```

Change it to:

```typescript
  const containerArgs = buildContainerArgs(mounts, containerName, group);
```

### 2.3 Extend setup/register.ts

**a) Add fields to RegisterArgs interface:**

```typescript
interface RegisterArgs {
  jid: string;
  name: string;
  trigger: string;
  folder: string;
  channel: string;
  requiresTrigger: boolean;
  isMain: boolean;
  assistantName: string;
  network: string;  // Docker network name
  proxy: string;    // HTTP proxy URL
}
```

**b) Add defaults in parseArgs():**

In the `result` object initialization, add:

```typescript
    network: '',
    proxy: '',
```

**c) Add switch cases in parseArgs():**

Add these cases inside the `switch (args[i])` block:

```typescript
      case '--network':
        result.network = args[++i] || '';
        break;
      case '--proxy':
        result.proxy = args[++i] || '';
        break;
```

**d) Include containerConfig in setRegisteredGroup() call:**

Update the `setRegisteredGroup()` call to include containerConfig when network or proxy are specified:

```typescript
  const containerConfig: RegisteredGroup['containerConfig'] = {};
  if (parsed.network) containerConfig.dockerNetwork = parsed.network;
  if (parsed.proxy) containerConfig.httpProxy = parsed.proxy;

  setRegisteredGroup(parsed.jid, {
    name: parsed.name,
    folder: parsed.folder,
    trigger: parsed.trigger,
    added_at: new Date().toISOString(),
    requiresTrigger: parsed.requiresTrigger,
    isMain: parsed.isMain,
    ...(Object.keys(containerConfig).length > 0 ? { containerConfig } : {}),
  });
```

You will need to add the import for `RegisteredGroup` from `../src/types.ts` at the top of the file.

### 2.4 Extend IPC register_group tool in container/agent-runner/src/ipc-mcp-stdio.ts

**a) Add optional fields to the Zod schema:**

```typescript
server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    network: z.string().optional().describe('Docker network name (e.g., "nanoclaw-researcher")'),
    proxy: z.string().optional().describe('HTTP proxy URL (e.g., "http://172.20.0.2:3128")'),
  },
```

**b) Include containerConfig in the IPC data:**

```typescript
    const containerConfig: Record<string, string> = {};
    if (args.network) containerConfig.dockerNetwork = args.network;
    if (args.proxy) containerConfig.httpProxy = args.proxy;

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      ...(Object.keys(containerConfig).length > 0 ? { containerConfig } : {}),
      timestamp: new Date().toISOString(),
    };
```

### 2.5 Update CLAUDE.md documentation

Add the following section to the root `CLAUDE.md`, after the "Container Build Cache" section:

```markdown
## Network Isolation

Groups can be assigned to Docker internal networks with optional HTTP proxy routing. Networks and proxies are pre-configured by Ansible — NanoClaw only assigns groups to them.

Available networks:
- `nanoclaw-researcher` — Squid proxy at `http://172.20.0.2:3128`
- `nanoclaw-operator` — no internet access
- `nanoclaw-coder` — Squid proxy at `http://172.22.0.2:3128`

Register a group with network isolation:
```bash
npx tsx setup/index.ts --step register \
  --jid <jid> --name <name> --folder <folder> --trigger <trigger> \
  --network nanoclaw-researcher --proxy http://172.20.0.2:3128
```

The agent's `register_group` IPC tool also accepts `network` and `proxy` parameters.

Groups without `--network` use Docker's default bridge (unrestricted internet).
```

## Phase 3: Validate

### Build and test

```bash
npm run build
npx vitest run
```

Both must pass before proceeding. Fix any TypeScript or test errors.

### Restart the service

```bash
# Linux (systemd)
systemctl --user restart nanoclaw
```

## Phase 4: Verify

Tell the user:

> Network isolation is ready. To assign a group to a network, re-register it with `--network` and `--proxy` flags, or use the agent's `register_group` tool with `network` and `proxy` parameters.
>
> Example:
> ```bash
> npx tsx setup/index.ts --step register \
>   --jid "120363336345536173@g.us" --name "Research Team" \
>   --folder "whatsapp_research-team" --trigger "@Andy" \
>   --network nanoclaw-researcher --proxy http://172.20.0.2:3128
> ```
>
> Containers for that group will now spawn on the `nanoclaw-researcher` network with HTTP/HTTPS traffic routed through Squid at 172.20.0.2:3128.

## What this skill does NOT do

- Create Docker networks (Ansible does this)
- Configure Squid proxies (Ansible does this)
- Set up iptables rules (Ansible does this)
- Modify existing group registrations automatically — groups must be re-registered with the new flags
