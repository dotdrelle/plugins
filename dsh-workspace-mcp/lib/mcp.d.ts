/**
 * MCP server 受监督连接（supervisor）+ 工具发现 + agent-scoped 注册。
 * 复用 @modelcontextprotocol/sdk，命名 mcp__<server>__<tool>（与 dsh-mcp-client 一致）。
 *
 * 连接监督机制移植自官方 @deepseek-ai/dsh-mcp-client 的 connection 模块：
 *   - 每次 attempt 一代全新 Client+transport（MCP SDK 把 Protocol 绑死在单个
 *     transport 上，重连必须换代，不能复用旧 client）
 *   - generation.onclose 驱动断线检测（stdio 子进程退出 / HTTP 连接断开）
 *   - 指数退避重连：initialDelayMs * 2^(n-1)，封顶 maxDelayMs
 *   - 一次断线共享一次尝试预算（maxAttempts）；连接存活 ≥ maxDelayMs 后预算
 *     重置——偶发崩溃的 server 能无限恢复，crash-loop 的会被掐掉
 *   - 预算耗尽：卸载该 server 全部工具并停止；改配置文件（watcher reload）
 *     或重启是唯一恢复路径
 *   - 监听 ToolListChangedNotification：server 热改工具列表即时重同步
 *   - close 竞态防护：失败一代 5s 内未确认关闭则停止重连，避免 stdio 进程重叠
 *   - 会话失效主动判定（ADR-0005）：streamable-http 的 server 重启/会话驱逐只表现为
 *     请求错误（HTTP 404 / "Session not found"），transport 不 close、onclose 永不
 *     触发；在工具调用与重同步失败路径上识别此类错误，主动换代重连
 *   - 官方对齐补齐（ADR-0006）：stdio 子进程 scrubbed 父环境继承、重复 public 名
 *     守卫、注册冲突整代回滚、outputSchema→structuredContent 输出契约、
 *     taskSupport=required 明确拒绝
 */
import type { ReconnectPolicy, ServerConfig } from "./config.js";
/**
 * 判断一个错误是否表明 server 侧会话已失效（server 重启 / 会话驱逐 / 重新部署）。
 *
 * 此类错误只会让当次请求失败——transport 不 close、onclose 永不触发，supervisor
 * 若无人上报就永远不知道会话已死（工具持续失败直到改配置或重启）。保守匹配：
 * 偶发 5xx、超时等瞬时错误不在此列，不应触发换代。
 */
export declare function isSessionLossError(error: unknown): boolean;
export declare function publicToolName(serverName: string, rawName: string): string;
/** 重连策略默认值（与官方 dsh-mcp-client 的 RECONNECT_DEFAULTS 一致）。 */
export declare const RECONNECT_DEFAULTS: Readonly<ReconnectPolicy>;
/**
 * 解析重连策略：yml per-server 覆盖 > 插件级（patch config）> 内置默认，逐项合并。
 * 合并后重判边界（Schemastery 只盖插件级一层，程序化构造可绕过，故此处兜底）。
 *
 * @throws 策略非法时抛错（由调用方按 server 记日志跳过）。
 */
export declare function resolveReconnectPolicy(base: Partial<ReconnectPolicy> | undefined, override: Partial<ReconnectPolicy> | undefined, label: string): ReconnectPolicy;
/** 一个 server 的受监督连接句柄：自管理重连，dispose 时清理全部资源。 */
export interface SupervisedServer {
    serverName: string;
    /** 首次连接尝试的结果（无论成败；重连在后台继续，不反映在此 promise）。 */
    ready: Promise<{
        error?: unknown;
    }>;
    /** 停止监督：断开当前连接、清重连计时器、卸载全部工具。幂等。 */
    dispose(): Promise<void>;
}
/**
 * 启动一个 MCP server 的受监督连接：连接 → 发现工具 → 注册到 agent 的
 * scoped tools 服务；断线/失败按 policy 指数退避重连并重新注册。
 *
 * 注意: agent.ctx 在 agent/created 时可能是 inactive，不能用 agentCtx.effect，
 * 所以返回 SupervisedServer，由调用方在 agent/disposed / reload 时 dispose。
 *
 * @returns 监督句柄（不抛错；失败走重连策略，ready 携带首试结果）。
 */
export declare function startSupervisedConnection(agentCtx: any, serverName: string, cfg: ServerConfig, policy: ReconnectPolicy, log: (msg: string) => void): SupervisedServer;
