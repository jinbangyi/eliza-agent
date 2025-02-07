import { startAgents } from '../src/index.ts';

const plugins: { name: string; description: string }[] = [];

startAgents(plugins).catch((error) => {
    console.error('Unhandled error in startAgents:', error);
    process.exit(1);
});
