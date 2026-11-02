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
/**
 * 重连策略（与官方 dsh-mcp-client 的 reconnect 字段对齐）。
 * 配置层只管 shape；默认值与边界判定在 mcp.ts 的 resolveReconnectPolicy。
 */
export interface ReconnectPolicy {
    enabled: boolean;
    /** 首次重连延迟（毫秒），此后指数翻倍。 */
    initialDelayMs: number;
    /** 退避封顶（毫秒）；也充当"健康稳定窗口"——连接存活超过它则重置尝试预算。 */
    maxDelayMs: number;
    /** 一次断线周期内最大连续失败尝试次数。 */
    maxAttempts: number;
}
/** 单个 MCP server 的配置（与 dsh-mcp-client Config 字段对齐）。 */
export interface ServerConfig {
    transport: "stdio" | "streamable-http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    /** 单次 callTool 超时（毫秒），默认 60000。 */
    toolCallTimeoutMs?: number;
    /** 重连策略覆盖（逐项覆盖插件级配置，缺省回退插件级/内置默认）。 */
    reconnect?: Partial<ReconnectPolicy>;
}
/** 项目级 MCP 配置文件根。 */
export interface McpConfig {
    servers: Record<string, ServerConfig>;
}
/** serverName 合法字符（与 dsh-mcp-client 一致）。 */
export declare const SERVER_NAME_PATTERN: RegExp;
/**
 * 读取并解析项目级 MCP 配置。
 *
 * @param cwd - session 的工作目录（workspace 根）。
 * @param relativePath - 配置文件相对 cwd 的路径，默认 ".dsh/mcp.servers.yml"。
 * @returns 解析后的配置；文件不存在则返回 null（该 workspace 无项目级 MCP）。
 * @throws 配置文件存在但格式非法时抛错（缺 transport、serverName 非法等）。
 */
export declare function loadWorkspaceMcpConfig(cwd: string, relativePath?: string): McpConfig | null;
/** 用 js-yaml 解析（DSH 运行时已包含，app-boot 也用它）。 */ 
