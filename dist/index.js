// src/index.ts
import {
  AgentRuntime,
  CacheManager,
  CacheStore,
  DbCacheAdapter,
  defaultCharacter,
  elizaLogger,
  FsCacheAdapter,
  ModelProviderName,
  parseBooleanFromText,
  settings,
  stringToUuid,
  validateCharacterConfig
} from "@elizaos/core";
import { SqliteDatabaseAdapter } from "@elizaos/adapter-sqlite";
import { DirectClient } from "@elizaos/client-direct";
import { normalizeCharacter } from "@elizaos/plugin-di";
import Database from "better-sqlite3";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import yargs from "yargs";
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var wait = (minTime = 1e3, maxTime = 3e3) => {
  const waitTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};
var logFetch = async (url, options) => {
  elizaLogger.debug(`Fetching ${url}`);
  return fetch(url, options);
};
function parseArguments() {
  try {
    return yargs(process.argv.slice(3)).option("character", {
      type: "string",
      description: "Path to the character JSON file"
    }).option("characters", {
      type: "string",
      description: "Comma separated list of paths to character JSON files"
    }).parseSync();
  } catch (error) {
    elizaLogger.error("Error parsing arguments:", error);
    return {};
  }
}
function tryLoadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    elizaLogger.error(`Error loading file ${filePath}: ${e}`);
    return null;
  }
}
function mergeCharacters(base, child) {
  const mergeObjects = (baseObj, childObj) => {
    const result = {};
    const keys = /* @__PURE__ */ new Set([...Object.keys(baseObj || {}), ...Object.keys(childObj || {})]);
    for (const key of keys) {
      if (typeof baseObj[key] === "object" && typeof childObj[key] === "object" && !Array.isArray(baseObj[key]) && !Array.isArray(childObj[key])) {
        result[key] = mergeObjects(baseObj[key], childObj[key]);
      } else if (Array.isArray(baseObj[key]) || Array.isArray(childObj[key])) {
        result[key] = [...baseObj[key] || [], ...childObj[key] || []];
      } else {
        result[key] = childObj[key] !== void 0 ? childObj[key] : baseObj[key];
      }
    }
    return result;
  };
  return mergeObjects(base, child);
}
async function loadCharactersFromUrl(url) {
  try {
    const response = await fetch(url);
    const responseJson = await response.json();
    let characters = [];
    if (Array.isArray(responseJson)) {
      characters = await Promise.all(
        responseJson.map((character) => jsonToCharacter(url, character))
      );
    } else {
      const character = await jsonToCharacter(url, responseJson);
      characters.push(character);
    }
    return characters;
  } catch (e) {
    elizaLogger.error(`Error loading character(s) from ${url}: ${e}`);
    process.exit(1);
  }
}
async function jsonToCharacter(filePath, character) {
  validateCharacterConfig(character);
  const characterId = character.id || character.name;
  const characterPrefix = `CHARACTER.${characterId.toUpperCase().replace(/ /g, "_")}.`;
  const characterSettings = Object.entries(process.env).filter(([key]) => key.startsWith(characterPrefix)).reduce((settings2, [key, value]) => {
    if (value) {
      const settingKey = key.slice(characterPrefix.length);
      settings2[settingKey] = value;
    }
    return settings2;
  }, {});
  if (Object.keys(characterSettings).length > 0) {
    character.settings = character.settings || {};
    character.settings.secrets = {
      ...characterSettings,
      ...character.settings.secrets
    };
  }
  const plugins = await handlePluginImporting(character.plugins);
  let retCharacter = { ...character, plugins };
  if (character.extends) {
    elizaLogger.info(`Merging  ${character.name} character with parent characters`);
    for (const extendPath of character.extends) {
      const baseCharacter = await loadCharacter(
        path.resolve(path.dirname(filePath), extendPath)
      );
      retCharacter = mergeCharacters(baseCharacter, retCharacter);
      elizaLogger.info(`Merged ${character.name} with ${baseCharacter.name}`);
    }
  }
  return retCharacter;
}
async function loadCharacter(filePath) {
  const content = tryLoadFile(filePath);
  if (!content) {
    throw new Error(`Character file not found: ${filePath}`);
  }
  const character = JSON.parse(content);
  return jsonToCharacter(filePath, character);
}
async function loadCharacterTryPath(characterPath) {
  let content = null;
  let resolvedPath = "";
  const pathsToTry = [
    characterPath,
    // exact path as specified
    path.resolve(process.cwd(), characterPath),
    // relative to cwd
    path.resolve(process.cwd(), "agent", characterPath),
    // Add this
    path.resolve(__dirname, characterPath),
    // relative to current script
    path.resolve(__dirname, "characters", path.basename(characterPath)),
    // relative to agent/characters
    path.resolve(__dirname, "../characters", path.basename(characterPath)),
    // relative to characters dir from agent
    path.resolve(__dirname, "../../characters", path.basename(characterPath))
    // relative to project root characters dir
  ];
  elizaLogger.info(
    "Trying paths:",
    pathsToTry.map((p) => ({
      path: p,
      exists: fs.existsSync(p)
    }))
  );
  for (const tryPath of pathsToTry) {
    content = tryLoadFile(tryPath);
    if (content !== null) {
      resolvedPath = tryPath;
      break;
    }
  }
  if (content === null) {
    elizaLogger.error(
      `Error loading character from ${characterPath}: File not found in any of the expected locations`
    );
    elizaLogger.error("Tried the following paths:");
    pathsToTry.forEach((p) => elizaLogger.error(` - ${p}`));
    throw new Error(
      `Error loading character from ${characterPath}: File not found in any of the expected locations`
    );
  }
  try {
    const character = await loadCharacter(resolvedPath);
    elizaLogger.info(`Successfully loaded character from: ${resolvedPath}`);
    return character;
  } catch (e) {
    elizaLogger.error(`Error parsing character from ${resolvedPath}: ${e}`);
    throw new Error(`Error parsing character from ${resolvedPath}: ${e}`);
  }
}
function commaSeparatedStringToArray(commaSeparated) {
  return commaSeparated?.split(",").map((value) => value.trim());
}
async function readCharactersFromStorage(characterPaths) {
  try {
    const uploadDir = path.join(process.cwd(), "data", "characters");
    await fs.promises.mkdir(uploadDir, { recursive: true });
    const fileNames = await fs.promises.readdir(uploadDir);
    fileNames.forEach((fileName) => {
      characterPaths.push(path.join(uploadDir, fileName));
    });
  } catch (err) {
    elizaLogger.error(`Error reading directory: ${err.message}`);
  }
  return characterPaths;
}
async function loadCharacters(charactersArg) {
  let characterPaths = commaSeparatedStringToArray(charactersArg);
  if (process.env.USE_CHARACTER_STORAGE === "true") {
    characterPaths = await readCharactersFromStorage(characterPaths);
  }
  const loadedCharacters = [];
  if (characterPaths?.length > 0) {
    for (const characterPath of characterPaths) {
      try {
        const character = await loadCharacterTryPath(characterPath);
        loadedCharacters.push(character);
      } catch (e) {
        elizaLogger.error(`Error load character: ${e}`);
        process.exit(1);
      }
    }
  }
  if (hasValidRemoteUrls()) {
    elizaLogger.info("Loading characters from remote URLs");
    const characterUrls = commaSeparatedStringToArray(process.env.REMOTE_CHARACTER_URLS ?? "");
    for (const characterUrl of characterUrls) {
      const characters = await loadCharactersFromUrl(characterUrl);
      loadedCharacters.push(...characters);
    }
  }
  if (loadedCharacters.length === 0) {
    elizaLogger.warn("No characters found, using default character");
    loadedCharacters.push(defaultCharacter);
  }
  return loadedCharacters;
}
async function handlePluginImporting(plugins) {
  if (plugins.length > 0) {
    elizaLogger.info("Plugins are: ", plugins);
    const importedPlugins = await Promise.all(
      plugins.map(async (plugin) => {
        try {
          const importedPlugin = await import(plugin);
          const functionName = `${plugin.replace("@elizaos/plugin-", "").replace(/-./g, (x) => x[1].toUpperCase())}Plugin`;
          return importedPlugin.default || importedPlugin[functionName];
        } catch (importError) {
          elizaLogger.error(`Failed to import plugin: ${plugin}`, importError);
          return [];
        }
      })
    );
    return importedPlugins;
  }
  return [];
}
function getTokenForProvider(provider, character) {
  switch (provider) {
    // no key needed for llama_local, ollama, lmstudio, gaianet or bedrock
    case ModelProviderName.LLAMALOCAL:
      return "";
    case ModelProviderName.OLLAMA:
      return "";
    case ModelProviderName.LMSTUDIO:
      return "";
    case ModelProviderName.GAIANET:
      return "";
    case ModelProviderName.BEDROCK:
      return "";
    case ModelProviderName.OPENAI:
      return character.settings?.secrets?.OPENAI_API_KEY || settings.OPENAI_API_KEY;
    case ModelProviderName.ETERNALAI:
      return character.settings?.secrets?.ETERNALAI_API_KEY || settings.ETERNALAI_API_KEY;
    case ModelProviderName.NINETEEN_AI:
      return character.settings?.secrets?.NINETEEN_AI_API_KEY || settings.NINETEEN_AI_API_KEY;
    case ModelProviderName.LLAMACLOUD:
    case ModelProviderName.TOGETHER:
      return character.settings?.secrets?.LLAMACLOUD_API_KEY || settings.LLAMACLOUD_API_KEY || character.settings?.secrets?.TOGETHER_API_KEY || settings.TOGETHER_API_KEY || character.settings?.secrets?.OPENAI_API_KEY || settings.OPENAI_API_KEY;
    case ModelProviderName.CLAUDE_VERTEX:
    case ModelProviderName.ANTHROPIC:
      return character.settings?.secrets?.ANTHROPIC_API_KEY || character.settings?.secrets?.CLAUDE_API_KEY || settings.ANTHROPIC_API_KEY || settings.CLAUDE_API_KEY;
    case ModelProviderName.REDPILL:
      return character.settings?.secrets?.REDPILL_API_KEY || settings.REDPILL_API_KEY;
    case ModelProviderName.OPENROUTER:
      return character.settings?.secrets?.OPENROUTER_API_KEY || settings.OPENROUTER_API_KEY;
    case ModelProviderName.GROK:
      return character.settings?.secrets?.GROK_API_KEY || settings.GROK_API_KEY;
    case ModelProviderName.HEURIST:
      return character.settings?.secrets?.HEURIST_API_KEY || settings.HEURIST_API_KEY;
    case ModelProviderName.GROQ:
      return character.settings?.secrets?.GROQ_API_KEY || settings.GROQ_API_KEY;
    case ModelProviderName.GALADRIEL:
      return character.settings?.secrets?.GALADRIEL_API_KEY || settings.GALADRIEL_API_KEY;
    case ModelProviderName.FAL:
      return character.settings?.secrets?.FAL_API_KEY || settings.FAL_API_KEY;
    case ModelProviderName.ALI_BAILIAN:
      return character.settings?.secrets?.ALI_BAILIAN_API_KEY || settings.ALI_BAILIAN_API_KEY;
    case ModelProviderName.VOLENGINE:
      return character.settings?.secrets?.VOLENGINE_API_KEY || settings.VOLENGINE_API_KEY;
    case ModelProviderName.NANOGPT:
      return character.settings?.secrets?.NANOGPT_API_KEY || settings.NANOGPT_API_KEY;
    case ModelProviderName.HYPERBOLIC:
      return character.settings?.secrets?.HYPERBOLIC_API_KEY || settings.HYPERBOLIC_API_KEY;
    case ModelProviderName.VENICE:
      return character.settings?.secrets?.VENICE_API_KEY || settings.VENICE_API_KEY;
    case ModelProviderName.ATOMA:
      return character.settings?.secrets?.ATOMASDK_BEARER_AUTH || settings.ATOMASDK_BEARER_AUTH;
    case ModelProviderName.NVIDIA:
      return character.settings?.secrets?.NVIDIA_API_KEY || settings.NVIDIA_API_KEY;
    case ModelProviderName.AKASH_CHAT_API:
      return character.settings?.secrets?.AKASH_CHAT_API_KEY || settings.AKASH_CHAT_API_KEY;
    case ModelProviderName.GOOGLE:
      return character.settings?.secrets?.GOOGLE_GENERATIVE_AI_API_KEY || settings.GOOGLE_GENERATIVE_AI_API_KEY;
    case ModelProviderName.MISTRAL:
      return character.settings?.secrets?.MISTRAL_API_KEY || settings.MISTRAL_API_KEY;
    case ModelProviderName.LETZAI:
      return character.settings?.secrets?.LETZAI_API_KEY || settings.LETZAI_API_KEY;
    case ModelProviderName.INFERA:
      return character.settings?.secrets?.INFERA_API_KEY || settings.INFERA_API_KEY;
    case ModelProviderName.DEEPSEEK:
      return character.settings?.secrets?.DEEPSEEK_API_KEY || settings.DEEPSEEK_API_KEY;
    case ModelProviderName.LIVEPEER:
      return character.settings?.secrets?.LIVEPEER_GATEWAY_URL || settings.LIVEPEER_GATEWAY_URL;
    default: {
      const errorMessage = `Failed to get token - unsupported model provider: ${provider}`;
      elizaLogger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }
}
async function initializeClients(character, runtime) {
  const clients = {};
  function determineClientType(client) {
    if ("type" in client) {
      return client.type ?? `client_${Date.now()}`;
    }
    const constructorName = client.constructor?.name;
    if (constructorName && !constructorName.includes("Object")) {
      return constructorName.toLowerCase().replace("client", "");
    }
    return `client_${Date.now()}`;
  }
  if (character.plugins?.length > 0) {
    for (const plugin of character.plugins) {
      if (plugin.clients) {
        for (const client of plugin.clients) {
          const startedClient = await client.start(runtime);
          const clientType = determineClientType(client);
          elizaLogger.debug(`Initializing client of type: ${clientType}`);
          clients[clientType] = startedClient;
        }
      }
    }
  }
  return clients;
}
function initializeDatabase(dataDir) {
  const filePath = process.env.SQLITE_FILE ?? path.resolve(dataDir, "db.sqlite");
  elizaLogger.info(`Initializing SQLite database at ${filePath}...`);
  const db = new SqliteDatabaseAdapter(new Database(filePath));
  db.init().then(() => {
    elizaLogger.success("Successfully connected to SQLite database");
  }).catch((error) => {
    elizaLogger.error("Failed to connect to SQLite:", error);
  });
  return db;
}
async function createAgent(character, db, cache, token) {
  elizaLogger.log(`Creating runtime for character ${character.name}`);
  return new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: character.modelProvider,
    evaluators: [],
    character,
    // character.plugins are handled when clients are added
    plugins: [].flat().filter(Boolean),
    providers: [],
    managers: [],
    cacheManager: cache,
    fetch: logFetch
  });
}
function initializeFsCache(baseDir, character) {
  if (!character?.id) {
    throw new Error("initializeFsCache requires id to be set in character definition");
  }
  const cacheDir = path.resolve(baseDir, character.id, "cache");
  const cache = new CacheManager(new FsCacheAdapter(cacheDir));
  return cache;
}
function initializeDbCache(character, db) {
  if (!character?.id) {
    throw new Error("initializeFsCache requires id to be set in character definition");
  }
  const cache = new CacheManager(new DbCacheAdapter(db, character.id));
  return cache;
}
function initializeCache(cacheStore, character, baseDir, db) {
  switch (cacheStore) {
    case CacheStore.DATABASE:
      if (db) {
        elizaLogger.info("Using Database Cache...");
        return initializeDbCache(character, db);
      }
      throw new Error("Database adapter is not provided for CacheStore.Database.");
    case CacheStore.FILESYSTEM:
      elizaLogger.info("Using File System Cache...");
      if (!baseDir) {
        throw new Error("baseDir must be provided for CacheStore.FILESYSTEM.");
      }
      return initializeFsCache(baseDir, character);
    default:
      throw new Error(
        `Invalid cache store: ${cacheStore} or required configuration missing.`
      );
  }
}
async function startAgent(character, directClient) {
  let db = void 0;
  try {
    character.id ??= stringToUuid(character.name);
    character.username ??= character.name;
    const token = getTokenForProvider(character.modelProvider, character);
    const dataDir = path.join(__dirname, "../data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    db = initializeDatabase(dataDir);
    await db.init();
    const cache = initializeCache(
      process.env.CACHE_STORE ?? CacheStore.FILESYSTEM,
      character,
      "data",
      db
    );
    const runtime = await createAgent(character, db, cache, token ?? "");
    await runtime.initialize();
    runtime.clients = await initializeClients(character, runtime);
    directClient.registerAgent(runtime);
    elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);
    return runtime;
  } catch (error) {
    elizaLogger.error(`Error starting agent for character ${character.name}: ${error}`);
    if (db) {
      await db.close();
    }
    throw error;
  }
}
var checkPortAvailable = (port) => {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
};
var hasValidRemoteUrls = () => process.env.REMOTE_CHARACTER_URLS && process.env.REMOTE_CHARACTER_URLS !== "" && process.env.REMOTE_CHARACTER_URLS.startsWith("http");
var startAgents = async (plugins) => {
  const directClient = new DirectClient();
  let serverPort = Number.parseInt(settings.SERVER_PORT || "3000");
  const args = parseArguments();
  const charactersArg = args.characters || args.character;
  let characters = [defaultCharacter];
  defaultCharacter.plugins = plugins;
  if (charactersArg) {
    characters = await loadCharacters(charactersArg);
  }
  characters = await Promise.all(characters.map(normalizeCharacter));
  try {
    for (const character of characters) {
      await startAgent(character, directClient);
    }
  } catch (error) {
    elizaLogger.error("Error starting agents:", error);
  }
  while (!await checkPortAvailable(serverPort)) {
    elizaLogger.warn(`Port ${serverPort} is in use, trying ${serverPort + 1}`);
    serverPort++;
  }
  directClient.startAgent = async (character) => {
    const plugins2 = await handlePluginImporting(character.plugins);
    return startAgent({ ...character, plugins: plugins2 }, directClient);
  };
  directClient.loadCharacterTryPath = loadCharacterTryPath;
  directClient.jsonToCharacter = jsonToCharacter;
  directClient.start(serverPort);
  if (serverPort !== Number.parseInt(settings.SERVER_PORT || "3000")) {
    elizaLogger.log(`Server started on alternate port ${serverPort}`);
  }
  elizaLogger.info(
    "Run `pnpm start:client` to start the client and visit the outputted URL (http://localhost:5173) to chat with your agents. When running multiple agents, use client with different port `SERVER_PORT=3001 pnpm start:client`"
  );
};
if (process.env.PREVENT_UNHANDLED_EXIT && parseBooleanFromText(process.env.PREVENT_UNHANDLED_EXIT)) {
  process.on("uncaughtException", (err) => {
    console.error("uncaughtException", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("unhandledRejection", err);
  });
}
export {
  createAgent,
  getTokenForProvider,
  initializeClients,
  loadCharacters,
  parseArguments,
  startAgents,
  wait
};
//# sourceMappingURL=index.js.map