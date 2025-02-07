import { Character, ModelProviderName, IAgentRuntime, IDatabaseAdapter, ICacheManager, AgentRuntime } from '@elizaos/core';

declare const wait: (minTime?: number, maxTime?: number) => Promise<unknown>;
declare function parseArguments(): {
    character?: string;
    characters?: string;
};
declare function loadCharacters(charactersArg: string): Promise<Character[]>;
declare function getTokenForProvider(provider: ModelProviderName, character: Character): string | undefined;
declare function initializeClients(character: Character, runtime: IAgentRuntime): Promise<Record<string, unknown>>;
declare function createAgent(character: Character, db: IDatabaseAdapter, cache: ICacheManager, token: string): Promise<AgentRuntime>;
declare const startAgents: (plugins: {
    name: string;
    description: string;
}[]) => Promise<void>;

export { createAgent, getTokenForProvider, initializeClients, loadCharacters, parseArguments, startAgents, wait };
