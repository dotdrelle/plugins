/**
 * 项目级 MCP 配置文件解析。
 *
 * 文件格式（YAML，默认路径 <cwd>/.dsh/mcp.servers.yml）:
 *
 *   servers:
 *     my-server:
 *       transport: stdio
 *       command: npx
 *       args: ["-y", "foo-mcp"]
 *       env: {}
 *     remote:
 *       transport: streamable-http
 *       url: https://example.com/mcp
 *       headers:
 *         Authorization: "Bearer xxx"
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
/** serverName 合法字符（与 dsh-mcp-client 一致）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/**
 * 读取并解析项目级 MCP 配置。
 *
 * @param cwd - session 的工作目录（workspace 根）。
 * @param relativePath - 配置文件相对 cwd 的路径，默认 ".dsh/mcp.servers.yml"。
 * @returns 解析后的配置；文件不存在则返回 null（该 workspace 无项目级 MCP）。
 * @throws 配置文件存在但格式非法时抛错（缺 transport、serverName 非法等）。
 */
export function loadWorkspaceMcpConfig(cwd, relativePath = ".dsh/mcp.servers.yml") {
    const filePath = resolve(cwd, relativePath);
    let raw;
    try {
        raw = readFileSync(filePath, "utf8");
    }
    catch (e) {
        if (e?.code === "ENOENT")
            return null;
        throw new Error(`workspace-mcp: failed to read configuration ${filePath}: ${e?.message ?? e}`);
    }
    const parsed = yaml.load(raw);
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`workspace-mcp: ${filePath} top level must be a mapping`);
    }
    const serversRaw = parsed.servers;
    if (serversRaw === undefined)
        return { servers: {} };
    if (typeof serversRaw !== "object" || serversRaw === null) {
        throw new Error(`workspace-mcp: ${filePath} servers must be a mapping`);
    }
    const servers = {};
    for (const [name, cfg] of Object.entries(serversRaw)) {
        servers[name] = validateServerConfig(filePath, name, cfg);
    }
    return { servers };
}
/** 校验单个 server 配置。 */
function validateServerConfig(filePath, name, cfg) {
    if (!SERVER_NAME_PATTERN.test(name)) {
        throw new Error(`workspace-mcp: ${filePath} invalid server name "${name}" (must match ${SERVER_NAME_PATTERN})`);
    }
    if (typeof cfg !== "object" || cfg === null) {
        throw new Error(`workspace-mcp: ${filePath} server "${name}" must be a mapping`);
    }
    const transport = cfg.transport;
    if (transport !== "stdio" && transport !== "streamable-http") {
        throw new Error(`workspace-mcp: ${filePath} server "${name}" transport must be "stdio" or "streamable-http"`);
    }
    const out = { transport };
    if (transport === "stdio") {
        if (typeof cfg.command !== "string") {
            throw new Error(`workspace-mcp: ${filePath} server "${name}" (stdio) is missing command`);
        }
        out.command = cfg.command;
        if (cfg.args !== undefined) {
            if (!Array.isArray(cfg.args) || !cfg.args.every((a) => typeof a === "string")) {
                throw new Error(`workspace-mcp: ${filePath} server "${name}" args must be an array of strings`);
            }
            out.args = cfg.args;
        }
        if (cfg.env !== undefined)
            out.env = normalizeStringMap(cfg.env, filePath, name, "env");
        if (cfg.cwd !== undefined && typeof cfg.cwd === "string")
            out.cwd = cfg.cwd;
    }
    else {
        if (typeof cfg.url !== "string") {
            throw new Error(`workspace-mcp: ${filePath} server "${name}" (streamable-http) is missing url`);
        }
        out.url = cfg.url;
        if (cfg.headers !== undefined)
            out.headers = normalizeStringMap(cfg.headers, filePath, name, "headers");
    }
    if (cfg.toolCallTimeoutMs !== undefined) {
        if (typeof cfg.toolCallTimeoutMs !== "number" || cfg.toolCallTimeoutMs <= 0) {
            throw new Error(`workspace-mcp: ${filePath} server "${name}" toolCallTimeoutMs must be a positive number`);
        }
        out.toolCallTimeoutMs = cfg.toolCallTimeoutMs;
    }
    if (cfg.reconnect !== undefined) {
        out.reconnect = validateReconnect(cfg.reconnect, filePath, name);
    }
    return out;
}
/** 校验 per-server reconnect 覆盖块（shape 级；跨字段边界在 resolveReconnectPolicy 判）。 */
function validateReconnect(v, filePath, name) {
    if (typeof v !== "object" || v === null) {
        throw new Error(`workspace-mcp: ${filePath} server "${name}" reconnect must be a mapping`);
    }
    for (const key of Object.keys(v)) {
        if (!["enabled", "initialDelayMs", "maxDelayMs", "maxAttempts"].includes(key)) {
            throw new Error(`workspace-mcp: ${filePath} server "${name}" reconnect.${key} is not a valid field`);
        }
    }
    const out = {};
    if (v.enabled !== undefined) {
        if (typeof v.enabled !== "boolean") {
            throw new Error(`workspace-mcp: ${filePath} server "${name}" reconnect.enabled must be a boolean`);
        }
        out.enabled = v.enabled;
    }
    for (const key of ["initialDelayMs", "maxDelayMs"]) {
        if (v[key] !== undefined) {
            if (typeof v[key] !== "number" || !Number.isFinite(v[key]) || v[key] <= 0) {
                throw new Error(`workspace-mcp: ${filePath} server "${name}" reconnect.${key} must be a positive number`);
            }
            out[key] = v[key];
        }
    }
    if (v.maxAttempts !== undefined) {
        if (typeof v.maxAttempts !== "number" || !Number.isInteger(v.maxAttempts) || v.maxAttempts < 1) {
            throw new Error(`workspace-mcp: ${filePath} server "${name}" reconnect.maxAttempts must be a positive integer`);
        }
        out.maxAttempts = v.maxAttempts;
    }
    return out;
}
function normalizeStringMap(v, filePath, name, field) {
    if (typeof v !== "object" || v === null) {
        throw new Error(`workspace-mcp: ${filePath} server "${name}" ${field} must be a string-to-string mapping`);
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        out[k] = typeof val === "string" ? val : String(val);
    }
    return out;
}
/** 用 js-yaml 解析（DSH 运行时已包含，app-boot 也用它）。 */ 
//# sourceMappingURL=config.js.map