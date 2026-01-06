// src/rpc-logger.ts
// Request logging for RPC and API calls with stats tracking

import * as fs from "fs";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RequestLog {
  timestamp: string;
  provider: string;
  chain: string;
  method?: string;
  success: boolean;
  responseTime: number;
  error?: string;
}

export interface ProviderStats {
  totalRequests: number;
  successCount: number;
  failCount: number;
  avgResponseTime: number;
  lastHourRequests: number;
  todayRequests: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const recentLogs: RequestLog[] = [];
const MAX_RECENT_LOGS = 1000;

const providerStats: Map<string, ProviderStats> = new Map();
const hourlyRequests: Map<string, number[]> = new Map(); // provider -> timestamps

let logToFile = false;
let logFilePath = "";
let fileStream: fs.WriteStream | null = null;

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

export function initLogger(options?: { 
  logToFile?: boolean; 
  logDir?: string;
}): void {
  logToFile = options?.logToFile ?? !!process.env.LOG_RPC_TO_FILE;
  
  if (logToFile) {
    const logDir = options?.logDir ?? "./logs";
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const date = new Date().toISOString().split("T")[0];
    logFilePath = path.join(logDir, `rpc-${date}.log`);
    fileStream = fs.createWriteStream(logFilePath, { flags: "a" });
    
    console.log(`📝 RPC logging to: ${logFilePath}`);
  }
  
  // Cleanup old hourly data every hour
  setInterval(cleanupHourlyData, 60 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logRequest(
  provider: string,
  chain: string,
  success: boolean,
  responseTime: number,
  method?: string,
  error?: string
): void {
  const now = new Date();
  const timestamp = now.toISOString();
  
  const log: RequestLog = {
    timestamp,
    provider,
    chain,
    method,
    success,
    responseTime,
    error: error?.slice(0, 100),
  };
  
  // Add to recent logs (circular buffer)
  recentLogs.push(log);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.shift();
  }
  
  // Update provider stats
  updateStats(provider, success, responseTime, now.getTime());
  
  // Console logging (if DEBUG_RPC enabled)
  if (process.env.DEBUG_RPC) {
    const status = success ? "✓" : "✗";
    const timeStr = `${responseTime}ms`.padStart(6);
    const providerStr = provider.padEnd(20);
    const chainStr = chain.toUpperCase().padEnd(4);
    const methodStr = method ? ` ${method}` : "";
    const errorStr = error ? ` [${error.slice(0, 30)}]` : "";
    
    console.log(`[RPC] ${status} ${chainStr} ${providerStr} ${timeStr}${methodStr}${errorStr}`);
  }
  
  // File logging
  if (logToFile && fileStream) {
    const line = JSON.stringify(log) + "\n";
    fileStream.write(line);
  }
}

export function logMoralisRequest(
  keyIndex: number,
  success: boolean,
  responseTime: number,
  method?: string,
  error?: string
): void {
  logRequest(`moralis-${keyIndex + 1}`, "api", success, responseTime, method, error);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

function updateStats(provider: string, success: boolean, responseTime: number, timestamp: number): void {
  let stats = providerStats.get(provider);
  
  if (!stats) {
    stats = {
      totalRequests: 0,
      successCount: 0,
      failCount: 0,
      avgResponseTime: 0,
      lastHourRequests: 0,
      todayRequests: 0,
    };
    providerStats.set(provider, stats);
  }
  
  stats.totalRequests++;
  stats.todayRequests++;
  
  if (success) {
    stats.successCount++;
    // Update rolling average response time
    stats.avgResponseTime = stats.avgResponseTime * 0.9 + responseTime * 0.1;
  } else {
    stats.failCount++;
  }
  
  // Track hourly requests
  let hourly = hourlyRequests.get(provider);
  if (!hourly) {
    hourly = [];
    hourlyRequests.set(provider, hourly);
  }
  hourly.push(timestamp);
  
  // Count last hour
  const oneHourAgo = timestamp - 60 * 60 * 1000;
  stats.lastHourRequests = hourly.filter(t => t > oneHourAgo).length;
}

function cleanupHourlyData(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  
  for (const [provider, timestamps] of hourlyRequests.entries()) {
    const filtered = timestamps.filter(t => t > oneHourAgo);
    hourlyRequests.set(provider, filtered);
    
    const stats = providerStats.get(provider);
    if (stats) {
      stats.lastHourRequests = filtered.length;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export function getRecentLogs(count: number = 50): RequestLog[] {
  return recentLogs.slice(-count);
}

export function getProviderStats(): Record<string, ProviderStats> {
  const result: Record<string, ProviderStats> = {};
  for (const [provider, stats] of providerStats.entries()) {
    result[provider] = { ...stats };
  }
  return result;
}

export function getStats(): {
  totalRequests: number;
  successRate: number;
  avgResponseTime: number;
  requestsLastHour: number;
  byProvider: Record<string, ProviderStats>;
} {
  let totalRequests = 0;
  let totalSuccess = 0;
  let totalResponseTime = 0;
  let requestsLastHour = 0;
  
  for (const stats of providerStats.values()) {
    totalRequests += stats.totalRequests;
    totalSuccess += stats.successCount;
    totalResponseTime += stats.avgResponseTime * stats.totalRequests;
    requestsLastHour += stats.lastHourRequests;
  }
  
  return {
    totalRequests,
    successRate: totalRequests > 0 ? (totalSuccess / totalRequests) * 100 : 100,
    avgResponseTime: totalRequests > 0 ? totalResponseTime / totalRequests : 0,
    requestsLastHour,
    byProvider: getProviderStats(),
  };
}

export function printStats(): void {
  const stats = getStats();
  
  console.log("\n📊 RPC Statistics");
  console.log("─".repeat(60));
  console.log(`Total Requests: ${stats.totalRequests}`);
  console.log(`Success Rate: ${stats.successRate.toFixed(1)}%`);
  console.log(`Avg Response: ${stats.avgResponseTime.toFixed(0)}ms`);
  console.log(`Last Hour: ${stats.requestsLastHour} requests`);
  console.log("\nBy Provider:");
  
  for (const [provider, pStats] of Object.entries(stats.byProvider)) {
    const successRate = pStats.totalRequests > 0 
      ? ((pStats.successCount / pStats.totalRequests) * 100).toFixed(1) 
      : "100.0";
    console.log(`  ${provider.padEnd(25)} ${pStats.totalRequests.toString().padStart(6)} req | ${successRate}% ok | ${pStats.avgResponseTime.toFixed(0)}ms avg`);
  }
  console.log("─".repeat(60) + "\n");
}

export function resetStats(): void {
  providerStats.clear();
  hourlyRequests.clear();
  recentLogs.length = 0;
}

export function closeLogger(): void {
  if (fileStream) {
    fileStream.end();
    fileStream = null;
  }
}
