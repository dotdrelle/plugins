/**
 * @momojie-s/dsh-workspace-mcp
 *
 * 按 workspace（session.header.cwd）自动加载/卸载 MCP server。
 *
 * 机制:
 *   - 监听 agent/created（全局），agent 创建即异步连接 <cwd>/<configFile> 里的
 *     MCP server，在 agent.ctx scope 注册工具——首个模型请求即可见到 mcp__* 工具。
 *   - agent/pre-step 兜底：HMR 重载后已存在的 agent 没有 created 事件，首个
 *     pre-step 补初始化（await）。注意 assembly.tools 在 pre-step 前组装，
 *     pre-step 内的等待无法影响本步工具集，故不做等待。
 *   - 每个 server 一条受监督连接（mcp.ts，移植官方 dsh-mcp-client）：
 *     连接失败与中途断线均按指数退避自动重连并重新注册工具；预算耗尽才放弃
 *     （卸载工具，改配置文件或重启恢复）；监听工具列表变化通知即时重同步。
 *   - 用 chokidar 监听配置文件，变化时自动 dispose 旧 server、重新连接注册
 *     （改 .dsh/mcp.servers.yml 后当前会话立即生效，无需重启/新开会话）。
 *   - agent/disposed / fiber dispose 时断开连接、卸载工具、关闭 watcher，无泄漏。
 */
import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { type ReconnectPolicy } from "./config.js";
declare const name = "workspace-mcp";
declare const inject: string[];
interface PluginConfig {
    configFile: string;
    verbose: boolean;
    /** 文件变化后重新加载的防抖延迟（毫秒），避免编辑器多次保存触发抖动。 */
    reloadDebounceMs: number;
    /** 插件级重连默认（各 server 可在 yml 里逐项覆盖）。 */
    reconnect: Partial<ReconnectPolicy>;
}
declare const Config: z<Schemastery.ObjectS<NoInfer<{
    configFile: z<string, string, "defined">;
    verbose: z<boolean, boolean, "defined">;
    reloadDebounceMs: z<number, number, "defined">;
    reconnect: z<Schemastery.ObjectS<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        initialDelayMs: z<number, number, "defined">;
        maxDelayMs: z<number, number, "defined">;
        maxAttempts: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        initialDelayMs: z<number, number, "defined">;
        maxDelayMs: z<number, number, "defined">;
        maxAttempts: z<number, number, "defined">;
    }>>, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    configFile: z<string, string, "defined">;
    verbose: z<boolean, boolean, "defined">;
    reloadDebounceMs: z<number, number, "defined">;
    reconnect: z<Schemastery.ObjectS<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        initialDelayMs: z<number, number, "defined">;
        maxDelayMs: z<number, number, "defined">;
        maxAttempts: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        initialDelayMs: z<number, number, "defined">;
        maxDelayMs: z<number, number, "defined">;
        maxAttempts: z<number, number, "defined">;
    }>>, "plain">;
}>>, "plain">;
declare function apply(ctx: Context, config: PluginConfig): void;
export { Config, apply, inject, name };
