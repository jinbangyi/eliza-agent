# eliza-agent

eliza-agent: `0.1.9`

## Quick Start

```bash
nvm use 23
pnpm add github:jinbangyi/eliza-agent#master
```

```typescript
import { startAgents } from '@elizaos/agent';

const plugins: { name: string; description: string }[] = [];

startAgents(plugins).catch((error) => {
    console.error('Unhandled error in startAgents:', error);
    process.exit(1);
});

```
