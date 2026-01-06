// src/rpc-manager.ts
// Multi-RPC load balancer with health checks, rate limiting, automatic failover
// Features: Multi-account support, runtime key rotation, zero-lag switching, secure key handling

import { ethers, FetchRequest } from "ethers";
import { ChainId } from "./appConfig";
import { logRequest, initLogger } from "./rpc-logger";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ProviderKey {
  id: string;                    // Unique identifier (e.g., "alchemy-1", "ankr-2")
  provider: string;              // Provider name
  keyIndex: number;              // Which account (0, 1, 2...)
  chains: ChainId[];             // Supported chains
  rateLimit: number;             // Requests per second
  dailyLimit?: number;           // Daily quota
  monthlyLimit?: number;         // Monthly quota
  supportsWebsocket: boolean;
  priority: number;              // Lower = preferred
  weight: number;                // Load balancing weight
}

interface KeyHealth {
  key: ProviderKey;
  isHealthy: boolean;
  lastError: string | null;
  requestCount: number;
  dailyRequests: number;
  monthlyRequests: number;
  lastRequestTime: number;
  avgResponseTime: number;
  consecutiveFailures: number;
  lastResetDay: number;
  lastResetMonth: number;
}

interface ChainEndpoint {
  keyHealth: KeyHealth;
  url: string;
  wsUrl?: string;
  provider: ethers.JsonRpcProvider | null;
  wsProvider: ethers.WebSocketProvider | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER CONFIGURATIONS
// Optimal chain assignments based on each provider's strengths
// Rate limits verified from official docs (Jan 2026)
// ═══════════════════════════════════════════════════════════════════════════════

const PROVIDER_CONFIG = {
  // ALCHEMY: Best overall - use for ALL chains (ETH, BSC, SOL)
  // Free: 30M CU/month, 500 CU/s throughput (~50 simple req/s, varies by method)
  // Source: https://docs.alchemy.com/reference/compute-units
  alchemy: {
    chains: ["eth", "bsc", "sol"] as ChainId[],
    rateLimit: 50,                 // ~500 CU/s ÷ 10 CU per simple call
    monthlyLimit: 30000000,
    supportsWebsocket: true,
    priority: 1,
    weight: 50,
    buildUrl: (key: string, chain: ChainId) => {
      const hosts: Record<ChainId, string> = {
        eth: "eth-mainnet.g.alchemy.com",
        bsc: "bnb-mainnet.g.alchemy.com",
        sol: "solana-mainnet.g.alchemy.com",
      };
      return `https://${hosts[chain]}/v2/${key}`;
    },
    buildWsUrl: (key: string, chain: ChainId) => {
      if (chain === "sol") return undefined;
      const hosts: Record<ChainId, string> = {
        eth: "eth-mainnet.g.alchemy.com",
        bsc: "bnb-mainnet.g.alchemy.com",
        sol: "",
      };
      return `wss://${hosts[chain]}/v2/${key}`;
    },
  },

  // ANKR: Good for ETH + BSC only (no Solana)
  // Free: 200M credits/month, 10 req/s (600 req/min)
  // Source: https://api-docs.ankr.com/reference/limits
  ankr: {
    chains: ["eth", "bsc"] as ChainId[],
    rateLimit: 10,                 // 600 req/min = 10 req/s
    monthlyLimit: 200000000,
    supportsWebsocket: false,
    priority: 2,
    weight: 30,
    buildUrl: (key: string, chain: ChainId) => {
      return `https://rpc.ankr.com/${chain}/${key}`;
    },
    buildWsUrl: () => undefined,
  },

  // GETBLOCK: Good for ETH + BSC (pick 2 chains per account)
  // Free: 50K CU/day, 20 RPS - daily reset!
  // Source: https://getblock.io/pricing/
  getblock: {
    chains: ["eth", "bsc"] as ChainId[],
    rateLimit: 20,
    dailyLimit: 50000,
    supportsWebsocket: false,
    priority: 3,
    weight: 15,
    buildUrl: (key: string, _chain: ChainId) => {
      // GetBlock uses access tokens, chain is embedded in token
      return `https://go.getblock.us/${key}`;
    },
    buildWsUrl: () => undefined,
  },

  // CHAINSTACK: 1 chain per account - create separate accounts
  // Free Developer: 3M RU/month, 25 RPS
  // Source: https://support.chainstack.com/hc/en-us/articles/6955614349209
  chainstack: {
    chains: ["eth", "bsc", "sol"] as ChainId[],
    rateLimit: 25,
    monthlyLimit: 3000000,
    supportsWebsocket: false,
    priority: 4,
    weight: 10,
    buildUrl: (url: string, _chain: ChainId) => url, // Full URL provided
    buildWsUrl: () => undefined,
  },

  // NOWNODES: Trial only, 5 networks
  // Free: 100K/month, 15 RPS
  nownodes: {
    chains: ["eth", "bsc"] as ChainId[],
    rateLimit: 15,
    monthlyLimit: 100000,
    supportsWebsocket: false,
    priority: 5,
    weight: 5,
    buildUrl: (key: string, chain: ChainId) => {
      const hosts: Record<ChainId, string> = {
        eth: "eth.nownodes.io",
        bsc: "bsc.nownodes.io",
        sol: "sol.nownodes.io",
      };
      return `https://${hosts[chain]}/${key}`;
    },
    buildWsUrl: () => undefined,
  },

  // INFURA: ETH + BSC
  // Free: 3M requests/month
  infura: {
    chains: ["eth", "bsc"] as ChainId[],
    rateLimit: 10,
    monthlyLimit: 3000000,
    supportsWebsocket: true,
    priority: 2,
    weight: 25,
    buildUrl: (key: string, chain: ChainId) => {
      const hosts: Record<ChainId, string> = {
        eth: "mainnet.infura.io",
        bsc: "bsc-mainnet.infura.io",
        sol: "",
      };
      return `https://${hosts[chain]}/v3/${key}`;
    },
    buildWsUrl: (key: string, chain: ChainId) => {
      if (chain === "sol") return undefined;
      const hosts: Record<ChainId, string> = {
        eth: "mainnet.infura.io",
        bsc: "bsc-mainnet.infura.io",
        sol: "",
      };
      return `wss://${hosts[chain]}/ws/v3/${key}`;
    },
  },

  // HELIUS: Solana only - excellent free tier
  // Free: 1M credits/month, 10 RPS, WebSocket included
  // DAS API: 2 req/s, Enhanced APIs: 2 req/s
  // Source: https://www.helius.dev/docs/billing/plans
  helius: {
    chains: ["sol"] as ChainId[],
    rateLimit: 10,
    monthlyLimit: 1000000,
    supportsWebsocket: true,
    priority: 1,
    weight: 50,
    buildUrl: (key: string, _chain: ChainId) => {
      return `https://mainnet.helius-rpc.com/?api-key=${key}`;
    },
    buildWsUrl: (key: string, _chain: ChainId) => {
      return `wss://mainnet.helius-rpc.com/?api-key=${key}`;
    },
  },
};

// Public fallbacks (no API key needed)
const PUBLIC_ENDPOINTS: Record<ChainId, string[]> = {
  eth: [
    "https://eth.llamarpc.com",
    "https://ethereum.publicnode.com",
  ],
  bsc: ["https://bsc-dataseed.binance.org", "https://bsc-dataseed1.defibit.io"],
  sol: [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

const keyHealthMap: Map<string, KeyHealth> = new Map();
const chainEndpoints: Map<string, ChainEndpoint[]> = new Map(); // chain -> endpoints
let healthCheckInterval: NodeJS.Timeout | null = null;
let quotaResetInterval: NodeJS.Timeout | null = null;

const COOLDOWN_MS = 60000;
const MAX_FAILURES = 3;
const HEALTH_CHECK_INTERVAL = 30000;

// ═══════════════════════════════════════════════════════════════════════════════
// KEY PARSING (Secure - keys only in memory, never logged)
// ═══════════════════════════════════════════════════════════════════════════════

function parseKeys(envVar: string | undefined): string[] {
  if (!envVar) return [];
  return envVar.split(',').map(k => k.trim()).filter(k => k.length > 0);
}

// Helper to get keys from multiple env vars (plural first, then singular)
function getKeys(pluralVar: string, singularVar: string): string[] {
  const plural = parseKeys(process.env[pluralVar]);
  if (plural.length > 0) return plural;
  return parseKeys(process.env[singularVar]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINT BUILDING
// ═══════════════════════════════════════════════════════════════════════════════

function buildAllEndpoints(): void {
  const now = new Date();
  
  // Initialize chain endpoint maps
  for (const chain of ["eth", "bsc", "sol"] as ChainId[]) {
    chainEndpoints.set(chain, []);
  }

  // ALCHEMY - All chains
  const alchemyKeys = getKeys('ALCHEMY_API_KEYS', 'ALCHEMY_API_KEY');
  alchemyKeys.forEach((key, idx) => {
    const config = PROVIDER_CONFIG.alchemy;
    const keyId = `alchemy-${idx + 1}`;
    
    const keyHealth: KeyHealth = {
      key: {
        id: keyId,
        provider: "alchemy",
        keyIndex: idx,
        chains: config.chains,
        rateLimit: config.rateLimit,
        monthlyLimit: config.monthlyLimit,
        supportsWebsocket: config.supportsWebsocket,
        priority: config.priority,
        weight: config.weight,
      },
      isHealthy: true,
      lastError: null,
      requestCount: 0,
      dailyRequests: 0,
      monthlyRequests: 0,
      lastRequestTime: 0,
      avgResponseTime: 0,
      consecutiveFailures: 0,
      lastResetDay: now.getDate(),
      lastResetMonth: now.getMonth(),
    };
    keyHealthMap.set(keyId, keyHealth);

    for (const chain of config.chains) {
      chainEndpoints.get(chain)!.push({
        keyHealth,
        url: config.buildUrl(key, chain),
        wsUrl: config.buildWsUrl(key, chain),
        provider: null,
        wsProvider: null,
      });
    }
  });

  // ANKR - ETH + BSC only
  const ankrKeys = getKeys('ANKR_API_KEYS', 'ANKR_API_KEY');
  ankrKeys.forEach((key, idx) => {
    const config = PROVIDER_CONFIG.ankr;
    const keyId = `ankr-${idx + 1}`;
    
    const keyHealth: KeyHealth = {
      key: {
        id: keyId,
        provider: "ankr",
        keyIndex: idx,
        chains: config.chains,
        rateLimit: config.rateLimit,
        monthlyLimit: config.monthlyLimit,
        supportsWebsocket: config.supportsWebsocket,
        priority: config.priority,
        weight: config.weight,
      },
      isHealthy: true,
      lastError: null,
      requestCount: 0,
      dailyRequests: 0,
      monthlyRequests: 0,
      lastRequestTime: 0,
      avgResponseTime: 0,
      consecutiveFailures: 0,
      lastResetDay: now.getDate(),
      lastResetMonth: now.getMonth(),
    };
    keyHealthMap.set(keyId, keyHealth);

    for (const chain of config.chains) {
      chainEndpoints.get(chain)!.push({
        keyHealth,
        url: config.buildUrl(key, chain),
        provider: null,
        wsProvider: null,
      });
    }
  });

  // GETBLOCK - ETH keys
  const getblockEthKeys = getKeys('GETBLOCK_ETH_KEYS', 'GETBLOCK_ETH_KEY');
  getblockEthKeys.forEach((key, idx) => {
    const config = PROVIDER_CONFIG.getblock;
    const keyId = `getblock-eth-${idx + 1}`;
    
    const keyHealth: KeyHealth = {
      key: {
        id: keyId,
        provider: "getblock",
        keyIndex: idx,
        chains: ["eth"],
        rateLimit: config.rateLimit,
        dailyLimit: config.dailyLimit,
        supportsWebsocket: config.supportsWebsocket,
        priority: config.priority,
        weight: config.weight,
      },
      isHealthy: true,
      lastError: null,
      requestCount: 0,
      dailyRequests: 0,
      monthlyRequests: 0,
      lastRequestTime: 0,
      avgResponseTime: 0,
      consecutiveFailures: 0,
      lastResetDay: now.getDate(),
      lastResetMonth: now.getMonth(),
    };
    keyHealthMap.set(keyId, keyHealth);

    chainEndpoints.get("eth")!.push({
      keyHealth,
      url: config.buildUrl(key, "eth"),
      provider: null,
      wsProvider: null,
    });
  });

  // GETBLOCK - BSC keys
  const getblockBscKeys = getKeys('GETBLOCK_BSC_KEYS', 'GETBLOCK_BSC_KEY');
  getblockBscKeys.forEach((key, idx) => {
    const config = PROVIDER_CONFIG.getblock;
    const keyId = `getblock-bsc-${idx + 1}`;
    
    const keyHealth: KeyHealth = {
      key: {
        id: keyId,
        provider: "getblock",
        keyIndex: idx,
        chains: ["bsc"],
        rateLimit: config.rateLimit,
        dailyLimit: config.dailyLimit,
        supportsWebsocket: config.supportsWebsocket,
        priority: config.priority,
        weight: config.weight,
      },
      isHealthy: true,
      lastError: null,
      requestCount: 0,
      dailyRequests: 0,
      monthlyRequests: 0,
      lastRequestTime: 0,
      avgResponseTime: 0,
      consecutiveFailures: 0,
      lastResetDay: now.getDate(),
      lastResetMonth: now.getMonth(),
    };
    keyHealthMap.set(keyId, keyHealth);

    chainEndpoints.get("bsc")!.push({
      keyHealth,
      url: config.buildUrl(key, "bsc"),
      provider: null,
      wsProvider: null,
    });
  });

  // CHAINSTACK - Full URLs per chain
  const chainstackUrls: Record<ChainId, string | undefined> = {
    eth: process.env.CHAINSTACK_ETH_URL,
    bsc: process.env.CHAINSTACK_BSC_URL,
    sol: process.env.CHAINSTACK_SOL_URL,
  };
  
  for (const [chain, url] of Object.entries(chainstackUrls)) {
    if (!url) continue;
    const config = PROVIDER_CONFIG.chainstack;
    const keyId = `chainstack-${chain}`;
    
    const keyHealth: KeyHealth = {
      key: {
        id: keyId,
        provider: "chainstack",
        keyIndex: 0,
        chains: [chain as ChainId],
        rateLimit: config.rateLimit,
        monthlyLimit: config.monthlyLimit,
        supportsWebsocket: config.supportsWebsocket,
        priority: config.priority,
        weight: config.weight,
      },
      isHealthy: true,
      lastError: null,
      requestCount: 0,
      dailyRequests: 0,
      monthlyRequests: 0,
      lastRequestTime: 0,
      avgResponseTime: 0,
      consecutiveFailures: 0,
      lastResetDay: now.getDate(),
      lastResetMonth: now.getMonth(),
    };
    keyHealthMap.set(keyId, keyHealth);

    chainEndpoints.get(chain as ChainId)!.push({
      keyHealth,
      url,
      provider: null,
      wsProvider: null,
    });
  }

  // NOWNODES
  const nownodesKey = process.env.NOWNODES_API_KEY;
  if (nownodesKey) {
    const config = PROVIDER_CONFIG.nownodes;
    for (const chain of config.chains) {
      const keyId = `nownodes-${chain}`;
      
      const keyHealth: KeyHealth = {
        key: {
          id: keyId,
          provider: "nownodes",
          keyIndex: 0,
          chains: [chain],
          rateLimit: config.rateLimit,
          monthlyLimit: config.monthlyLimit,
          supportsWebsocket: config.supportsWebsocket,
          priority: config.priority,
          weight: config.weight,
        },
        isHealthy: true,
        lastError: null,
        requestCount: 0,
        dailyRequests: 0,
        monthlyRequests: 0,
        lastRequestTime: 0,
        avgResponseTime: 0,
        consecutiveFailures: 0,
        lastResetDay: now.getDate(),
        lastResetMonth: now.getMonth(),
      };
      keyHealthMap.set(keyId, keyHealth);

      chainEndpoints.get(chain)!.push({
        keyHealth,
        url: config.buildUrl(nownodesKey, chain),
        provider: null,
        wsProvider: null,
      });
    }
  }

  // INFURA - ETH + BSC
  const infuraKeys = getKeys('INFURA_API_KEYS', 'INFURA_API_KEY');
  infuraKeys.forEach((key, idx) => {
    const config = PROVIDER_CONFIG.infura;
    const keyId = `infura-${idx + 1}`;
    
    const keyHealth: KeyHealth = {
      key: {
        id: keyId,
        provider: "infura",
        keyIndex: idx,
        chains: config.chains,
        rateLimit: config.rateLimit,
        monthlyLimit: config.monthlyLimit,
        supportsWebsocket: config.supportsWebsocket,
        priority: config.priority,
        weight: config.weight,
      },
      isHealthy: true,
      lastError: null,
      requestCount: 0,
      dailyRequests: 0,
      monthlyRequests: 0,
      lastRequestTime: 0,
      avgResponseTime: 0,
      consecutiveFailures: 0,
      lastResetDay: now.getDate(),
      lastResetMonth: now.getMonth(),
    };
    keyHealthMap.set(keyId, keyHealth);

    for (const chain of config.chains) {
      chainEndpoints.get(chain)!.push({
        keyHealth,
        url: config.buildUrl(key, chain),
        wsUrl: config.buildWsUrl(key, chain),
        provider: null,
        wsProvider: null,
      });
    }
  });

  // HELIUS - Solana only
  const heliusKeys = getKeys('HELIUS_API_KEYS', 'HELIUS_API_KEY');
  heliusKeys.forEach((key, idx) => {
    const config = PROVIDER_CONFIG.helius;
    const keyId = `helius-${idx + 1}`;
    
    const keyHealth: KeyHealth = {
      key: {
        id: keyId,
        provider: "helius",
        keyIndex: idx,
        chains: config.chains,
        rateLimit: config.rateLimit,
        monthlyLimit: config.monthlyLimit,
        supportsWebsocket: config.supportsWebsocket,
        priority: config.priority,
        weight: config.weight,
      },
      isHealthy: true,
      lastError: null,
      requestCount: 0,
      dailyRequests: 0,
      monthlyRequests: 0,
      lastRequestTime: 0,
      avgResponseTime: 0,
      consecutiveFailures: 0,
      lastResetDay: now.getDate(),
      lastResetMonth: now.getMonth(),
    };
    keyHealthMap.set(keyId, keyHealth);

    chainEndpoints.get("sol")!.push({
      keyHealth,
      url: config.buildUrl(key, "sol"),
      wsUrl: config.buildWsUrl(key, "sol"),
      provider: null,
      wsProvider: null,
    });
  });

  // PUBLIC FALLBACKS (no API key)
  for (const [chain, urls] of Object.entries(PUBLIC_ENDPOINTS)) {
    urls.forEach((url, idx) => {
      const keyId = `public-${chain}-${idx + 1}`;
      
      const keyHealth: KeyHealth = {
        key: {
          id: keyId,
          provider: "public",
          keyIndex: idx,
          chains: [chain as ChainId],
          rateLimit: 5,
          supportsWebsocket: false,
          priority: 99,
          weight: 1,
        },
        isHealthy: true,
        lastError: null,
        requestCount: 0,
        dailyRequests: 0,
        monthlyRequests: 0,
        lastRequestTime: 0,
        avgResponseTime: 0,
        consecutiveFailures: 0,
        lastResetDay: now.getDate(),
        lastResetMonth: now.getMonth(),
      };
      keyHealthMap.set(keyId, keyHealth);

      chainEndpoints.get(chain as ChainId)!.push({
        keyHealth,
        url,
        provider: null,
        wsProvider: null,
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUOTA & HEALTH MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function isWithinQuota(health: KeyHealth): boolean {
  const { dailyLimit, monthlyLimit } = health.key;
  if (dailyLimit && health.dailyRequests >= dailyLimit * 0.95) return false;
  if (monthlyLimit && health.monthlyRequests >= monthlyLimit * 0.95) return false;
  return true;
}

function resetQuotasIfNeeded(): void {
  const now = new Date();
  const currentDay = now.getDate();
  const currentMonth = now.getMonth();
  
  for (const health of keyHealthMap.values()) {
    if (health.lastResetDay !== currentDay) {
      health.dailyRequests = 0;
      health.lastResetDay = currentDay;
      // Re-enable keys that were disabled due to daily quota
      if (health.key.dailyLimit) health.isHealthy = true;
    }
    if (health.lastResetMonth !== currentMonth) {
      health.monthlyRequests = 0;
      health.lastResetMonth = currentMonth;
      health.isHealthy = true;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINT SELECTION (Weighted load balancing with zero-lag switching)
// ═══════════════════════════════════════════════════════════════════════════════

function weightedRandomSelect(endpoints: ChainEndpoint[]): ChainEndpoint | null {
  if (endpoints.length === 0) return null;
  
  const totalWeight = endpoints.reduce((sum, e) => sum + e.keyHealth.key.weight, 0);
  let random = Math.random() * totalWeight;
  
  for (const endpoint of endpoints) {
    random -= endpoint.keyHealth.key.weight;
    if (random <= 0) return endpoint;
  }
  
  return endpoints[0];
}

function selectBestEndpoint(chain: ChainId, excludeIds: Set<string> = new Set()): ChainEndpoint | null {
  const endpoints = chainEndpoints.get(chain) || [];
  
  const available = endpoints
    .filter(e => e.keyHealth.isHealthy)
    .filter(e => !excludeIds.has(e.keyHealth.key.id))
    .filter(e => isWithinQuota(e.keyHealth));
  
  if (available.length === 0) return null;
  
  // Sort by priority, then response time
  const sorted = available.sort((a, b) => {
    const priorityDiff = a.keyHealth.key.priority - b.keyHealth.key.priority;
    if (Math.abs(priorityDiff) > 10) return priorityDiff;
    return a.keyHealth.avgResponseTime - b.keyHealth.avgResponseTime;
  });
  
  // Use weighted selection among top-tier (priority <= 5)
  const topTier = sorted.filter(e => e.keyHealth.key.priority <= 5);
  if (topTier.length > 0) {
    return weightedRandomSelect(topTier);
  }
  
  return sorted[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function getOrCreateProvider(endpoint: ChainEndpoint): Promise<ethers.JsonRpcProvider> {
  if (!endpoint.provider) {
    const req = new FetchRequest(endpoint.url);
    req.timeout = 30000;
    endpoint.provider = new ethers.JsonRpcProvider(req);
  }
  return endpoint.provider;
}

async function rateLimit(health: KeyHealth): Promise<void> {
  const minInterval = 1000 / health.key.rateLimit;
  const elapsed = Date.now() - health.lastRequestTime;
  if (elapsed < minInterval) {
    await new Promise(r => setTimeout(r, minInterval - elapsed));
  }
  health.lastRequestTime = Date.now();
  health.requestCount++;
  health.dailyRequests++;
  health.monthlyRequests++;
}

function markSuccess(health: KeyHealth, responseTime: number): void {
  health.consecutiveFailures = 0;
  health.avgResponseTime = health.avgResponseTime 
    ? health.avgResponseTime * 0.8 + responseTime * 0.2 
    : responseTime;
}

function markFailure(health: KeyHealth, error: string): void {
  health.consecutiveFailures++;
  health.lastError = error;
  
  if (health.consecutiveFailures >= MAX_FAILURES) {
    health.isHealthy = false;
    console.warn(`⚠️ ${health.key.id} marked unhealthy: ${error.slice(0, 50)}`);
    setTimeout(() => { 
      health.isHealthy = true; 
      health.consecutiveFailures = 0; 
    }, COOLDOWN_MS);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

async function checkAllEndpoints(): Promise<void> {
  const failedEndpoints: { id: string; url: string; chain: ChainId; error: string }[] = [];
  
  // Check each chain's endpoints separately to use correct health check method
  for (const [chain, endpoints] of chainEndpoints.entries()) {
    const chainId = chain as ChainId;
    
    const checks = endpoints.map(async (endpoint) => {
      try {
        const start = Date.now();
        
        if (chainId === 'sol') {
          // Solana uses different RPC method
          const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
          });
          const data = await response.json();
          if (data.error) throw new Error(data.error.message);
        } else {
          // ETH/BSC use ethers provider
          const provider = await getOrCreateProvider(endpoint);
          await provider.getBlockNumber();
        }
        
        markSuccess(endpoint.keyHealth, Date.now() - start);
        endpoint.keyHealth.isHealthy = true;
      } catch (err: any) {
        endpoint.keyHealth.isHealthy = false;
        endpoint.keyHealth.lastError = err?.message;
        // Mask API key in URL for logging
        const maskedUrl = endpoint.url.replace(/\/v2\/[^\/]+/, '/v2/***').replace(/\/[a-f0-9]{32}$/i, '/***');
        failedEndpoints.push({
          id: endpoint.keyHealth.key.id,
          url: maskedUrl,
          chain: chainId,
          error: err?.message?.slice(0, 100) || 'Unknown error'
        });
      }
    });
    
    await Promise.allSettled(checks);
  }
  
  // Log failed endpoints
  if (failedEndpoints.length > 0) {
    console.log(`\n❌ Failed RPC endpoints:`);
    for (const failed of failedEndpoints) {
      console.log(`   ${failed.id} (${failed.chain.toUpperCase()}): ${failed.url}`);
      console.log(`      Error: ${failed.error}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export async function initRpcManager(): Promise<void> {
  // Initialize logger
  initLogger({ logToFile: !!process.env.LOG_RPC_TO_FILE });
  
  buildAllEndpoints();
  await checkAllEndpoints();
  
  healthCheckInterval = setInterval(checkAllEndpoints, HEALTH_CHECK_INTERVAL);
  quotaResetInterval = setInterval(resetQuotasIfNeeded, 60 * 60 * 1000);

  // Log summary (no keys exposed)
  console.log(`\n✅ RPC Manager initialized:`);
  console.log(`${"─".repeat(60)}`);
  
  for (const chain of ["eth", "bsc", "sol"] as ChainId[]) {
    const endpoints = chainEndpoints.get(chain) || [];
    const healthy = endpoints.filter(e => e.keyHealth.isHealthy);
    const providers = new Map<string, number>();
    
    for (const e of healthy) {
      const p = e.keyHealth.key.provider;
      providers.set(p, (providers.get(p) || 0) + 1);
    }
    
    const providerList = [...providers.entries()]
      .map(([p, count]) => `${p}(${count})`)
      .join(", ");
    
    console.log(`   ${chain.toUpperCase()}: ${healthy.length}/${endpoints.length} healthy → ${providerList || "none"}`);
  }
  
  console.log(`${"─".repeat(60)}\n`);
}

export async function getProvider(chain: ChainId): Promise<ethers.JsonRpcProvider> {
  const endpoint = selectBestEndpoint(chain);
  if (!endpoint) throw new Error(`No healthy RPC for ${chain}`);
  return getOrCreateProvider(endpoint);
}

export async function getWsProvider(chain: ChainId): Promise<ethers.WebSocketProvider | null> {
  const endpoints = chainEndpoints.get(chain) || [];
  
  for (const endpoint of endpoints) {
    if (endpoint.keyHealth.isHealthy && 
        endpoint.keyHealth.key.supportsWebsocket && 
        endpoint.wsUrl) {
      if (!endpoint.wsProvider) {
        try {
          endpoint.wsProvider = new ethers.WebSocketProvider(endpoint.wsUrl);
        } catch {
          continue;
        }
      }
      return endpoint.wsProvider;
    }
  }
  return null;
}

export async function executeWithFailover<T>(
  chain: ChainId,
  operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error | null = null;
  const triedIds = new Set<string>();
  
  for (let i = 0; i < maxRetries; i++) {
    const endpoint = selectBestEndpoint(chain, triedIds);
    if (!endpoint) break;
    
    triedIds.add(endpoint.keyHealth.key.id);
    
    try {
      await rateLimit(endpoint.keyHealth);
      const provider = await getOrCreateProvider(endpoint);
      const start = Date.now();
      const result = await operation(provider);
      const responseTime = Date.now() - start;
      
      markSuccess(endpoint.keyHealth, responseTime);
      logRequest(endpoint.keyHealth.key.id, chain, true, responseTime);
      
      return result;
    } catch (err: any) {
      const responseTime = Date.now() - endpoint.keyHealth.lastRequestTime;
      lastError = err;
      markFailure(endpoint.keyHealth, err?.message || "Unknown error");
      logRequest(endpoint.keyHealth.key.id, chain, false, responseTime, undefined, err?.message);
      
      // Silent failover - no lag
      if (i < maxRetries - 1) {
        const next = selectBestEndpoint(chain, triedIds);
        if (next && process.env.DEBUG_RPC) {
          console.log(`⚡ Failover: ${endpoint.keyHealth.key.id} → ${next.keyHealth.key.id}`);
        }
      }
    }
  }
  
  throw lastError || new Error(`All RPCs failed for ${chain}`);
}

export async function executeBatch<T>(
  chain: ChainId,
  operations: Array<(provider: ethers.JsonRpcProvider) => Promise<T>>,
  concurrency: number = 5
): Promise<T[]> {
  const results: T[] = [];
  const queue = [...operations];
  
  const workers = Array(Math.min(concurrency, queue.length)).fill(null).map(async () => {
    while (queue.length > 0) {
      const op = queue.shift();
      if (!op) break;
      
      try {
        const result = await executeWithFailover(chain, op);
        results.push(result);
      } catch (err) {
        if (process.env.DEBUG_RPC) {
          console.warn(`Batch op failed: ${err}`);
        }
      }
    }
  });
  
  await Promise.all(workers);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS & MONITORING (No key exposure)
// ═══════════════════════════════════════════════════════════════════════════════

export function getRpcStatus() {
  return [...keyHealthMap.values()].map(h => ({
    id: h.key.id,
    provider: h.key.provider,
    chains: h.key.chains,
    healthy: h.isHealthy,
    avgMs: Math.round(h.avgResponseTime),
    rps: h.key.rateLimit,
    requests: h.requestCount,
    daily: h.dailyRequests,
    dailyLimit: h.key.dailyLimit,
    monthly: h.monthlyRequests,
    monthlyLimit: h.key.monthlyLimit,
    quotaUsed: getQuotaPercent(h),
    error: h.lastError?.slice(0, 50),
  }));
}

function getQuotaPercent(health: KeyHealth): string {
  const { dailyLimit, monthlyLimit } = health.key;
  if (dailyLimit) {
    return `${((health.dailyRequests / dailyLimit) * 100).toFixed(1)}%/day`;
  }
  if (monthlyLimit) {
    return `${((health.monthlyRequests / monthlyLimit) * 100).toFixed(1)}%/mo`;
  }
  return "unlimited";
}

export function getRpcDetailedStatus() {
  const byChain: Record<ChainId, { healthy: number; total: number; endpoints: any[] }> = {
    eth: { healthy: 0, total: 0, endpoints: [] },
    bsc: { healthy: 0, total: 0, endpoints: [] },
    sol: { healthy: 0, total: 0, endpoints: [] },
  };
  
  for (const [chain, endpoints] of chainEndpoints.entries()) {
    const chainData = byChain[chain as ChainId];
    chainData.total = endpoints.length;
    
    for (const e of endpoints) {
      if (e.keyHealth.isHealthy) chainData.healthy++;
      
      chainData.endpoints.push({
        id: e.keyHealth.key.id,
        provider: e.keyHealth.key.provider,
        healthy: e.keyHealth.isHealthy,
        avgMs: Math.round(e.keyHealth.avgResponseTime),
        rps: e.keyHealth.key.rateLimit,
        quota: getQuotaPercent(e.keyHealth),
        priority: e.keyHealth.key.priority,
        websocket: e.keyHealth.key.supportsWebsocket,
      });
    }
  }
  
  return byChain;
}

export function shutdownRpcManager(): void {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  if (quotaResetInterval) clearInterval(quotaResetInterval);
  
  for (const endpoints of chainEndpoints.values()) {
    for (const e of endpoints) {
      try { e.wsProvider?.destroy(); } catch {}
    }
  }
  
  console.log("🛑 RPC Manager shutdown");
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMIT PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

interface PersistedRateLimit {
  providerId: string;
  dailyRequests: number;
  monthlyRequests: number;
  lastResetDay: number;
  lastResetMonth: number;
  updatedAt: Date;
}

export function loadPersistedRateLimits(limits: Map<string, PersistedRateLimit>): void {
  for (const [providerId, data] of limits) {
    const health = keyHealthMap.get(providerId);
    if (health) {
      health.dailyRequests = data.dailyRequests;
      health.monthlyRequests = data.monthlyRequests;
      health.lastResetDay = data.lastResetDay;
      health.lastResetMonth = data.lastResetMonth;
    }
  }
}

export function persistRateLimits(): PersistedRateLimit[] {
  const now = new Date();
  return [...keyHealthMap.values()].map(h => ({
    providerId: h.key.id,
    dailyRequests: h.dailyRequests,
    monthlyRequests: h.monthlyRequests,
    lastResetDay: h.lastResetDay,
    lastResetMonth: h.lastResetMonth,
    updatedAt: now,
  }));
}

export function getRateLimitSummary(): { id: string; daily: number; dailyLimit?: number; monthly: number; monthlyLimit?: number }[] {
  return [...keyHealthMap.values()].map(h => ({
    id: h.key.id,
    daily: h.dailyRequests,
    dailyLimit: h.key.dailyLimit,
    monthly: h.monthlyRequests,
    monthlyLimit: h.key.monthlyLimit,
  }));
}
