import { execFile, execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export const name = 'openspec-workbench';
export const inject = ['tools', 'systemPrompt'];

const edits = new Set(['write', 'edit', 'apply_patch']);
const maxBytes = 8 * 1024 * 1024;

/** 工作树绑定只适用于可证明与本机目录同路径的执行环境。 */
function localDirectory(agent) {
    if (!agent?.session) { return; }
    // Cordis 按 Agent 的执行环境选择服务，显式查询可访问该环境的活动 provider。
    const cwd = agent.ctx.get('workingDirectory')?.get(agent.session);
    if (typeof cwd === 'string' && isAbsolute(cwd) && agent.ctx.get('fs')?.processPathFromHostPath(cwd) === cwd) {
        return cwd;
    }
}

/** 命令的错误输出只采用桥接程序返回的用户提示，避免将运行环境写进会话。 */
async function callBridge(runnerPath, request, signal) {
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload) > maxBytes) { throw new Error('文档工具参数已超过大小限制。'); }
    signal?.throwIfAborted();
    const pending = execute(runnerPath, ['--tools', 'dsh'], {
        cwd: request.cwd, encoding: 'utf8', signal, timeout: 60000, maxBuffer: maxBytes, killSignal: 'SIGKILL'
    });
    pending.child.stdin.on('error', () => {});
    pending.child.stdin.end(payload);
    let stdout;
    try { ({ stdout } = await pending); }
    catch (error) {
        signal?.throwIfAborted();
        let result;
        try { result = JSON.parse(error.stdout); } catch { /* 子进程未返回结构化错误。 */ }
        throw new Error(typeof result?.error === 'string' ? result.error : '工作台文档工具未完成调用，请检查本机工作台。');
    }
    return JSON.parse(stdout);
}

function registerDocumentTools(ctx, runnerPath, options) {
    const catalog = JSON.parse(execFileSync(runnerPath, ['--tools', 'dsh'], {
        ...options, input: JSON.stringify({ action: 'catalog' }), stdio: ['pipe', 'pipe', 'pipe']
    }));
    // DSH 为每一步的所有 when 传入相同对象。下一步会重新读取实际绑定。
    const selections = new WeakMap();
    const directory = agent => {
        try { return localDirectory(agent); }
        catch { return undefined; }
    };
    async function available(context, name, requiredParameter) {
        const cwd = directory(context.agent);
        if (!cwd || context.signal.aborted) { return false; }
        let selection = selections.get(context);
        if (!selection || selection.cwd !== cwd) {
            const definitions = callBridge(runnerPath, { action: 'list', cwd }, context.signal)
                .then(reply => new Map(reply.tools.map(tool => [tool.name, tool])))
                .catch(() => {
                    if (!context.signal.aborted) { ctx.logger.warn('工作台无法列出当前工作树的文档工具。'); }
                    return new Map();
                });
            selection = { cwd, definitions };
            selections.set(context, selection);
        }
        const selected = (await selection.definitions).get(name);
        return Boolean(selected && (!requiredParameter || selected.inputSchema.properties[requiredParameter])) && directory(context.agent) === cwd;
    }
    function register({ name, description, inputSchema }, bridgeName = name, requiredParameter) {
        ctx.tools.register({
            name, description, parameters: inputSchema,
            output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            async execute(args, execution) {
                const cwd = directory(execution.agent);
                if (!cwd) { throw new Error('此会话缺少可映射到本机的工作树。'); }
                if (requiredParameter && !Object.hasOwn(args, requiredParameter)) { throw new Error('缺少工具参数 ' + requiredParameter + '。'); }
                const reply = await callBridge(runnerPath, { action: 'call', name: bridgeName, cwd, arguments: args }, execution.signal);
                return reply.result;
            }
        }, { when: context => available(context, bridgeName, requiredParameter) });
    }
    for (const tool of catalog.tools) {
        const properties = tool.inputSchema.properties;
        if (tool.name !== 'workbench_feishu_read_document' || !properties.inspectComment) { register(tool); continue; }
        // DSH 在插件加载时固定同名工具的参数。单独注册核对操作，才能按每一步的绑定显隐。
        const { inspectComment, ...readProperties } = properties;
        register({ ...tool, description: '读取飞书新版文档纯文本，长文按 nextOffset 接着读取。知识库链接需要飞书 3.0。',
            inputSchema: { ...tool.inputSchema, properties: readProperties } });
        register({ name: 'workbench_feishu_inspect_comment', description: '只读核对已有飞书文末批注的块、评论 ID 和当前文末位置。',
            inputSchema: { type: 'object', additionalProperties: false, required: ['document', 'inspectComment'],
                properties: { document: properties.document, inspectComment } } }, tool.name, 'inspectComment');
    }
}

export function apply(ctx, config) {
    if (typeof config?.runnerPath !== 'string' || !isAbsolute(config.runnerPath)) {
        throw new Error('工作台钩子程序需要绝对路径。');
    }

    const args = ['--host', 'dsh'];
    const options = { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: maxBytes };
    // 宿主日志只包含固定说明。失败的检查不会泄露调用参数或被当作规则拒绝。
    const warn = () => ctx.logger.warn('工作台钩子未完成本次检查，请在工作台核对接入和项目绑定。');
    const output = text => text ? JSON.parse(text).hookSpecificOutput : undefined;
    try { registerDocumentTools(ctx, config.runnerPath, options); }
    catch { ctx.logger.warn('工作台文档工具注册失败，请核对工作台安装并重新加载 DSH。'); }

    ctx.on('system-prompt/assemble', async (_presentation, context, next) => {
        const presentation = await next();
        if (context.signal?.aborted) { return presentation; }
        try {
            const cwd = localDirectory(context.agent);
            if (!cwd) { return presentation; }
            const pending = execute(config.runnerPath, args, { ...options, signal: context.signal });
            // 启动失败或取消时，子进程的退出结果负责报告异常。
            pending.child.stdin.on('error', () => {});
            pending.child.stdin.end(JSON.stringify({ hook_event_name: 'system-prompt/assemble', cwd }));
            const result = output((await pending).stdout);
            if (result?.additionalContext && !context.signal?.aborted && localDirectory(context.agent) === cwd) {
                return { ...presentation, contexts: [...presentation.contexts, {
                    name: 'openspec-workbench:project', text: result.additionalContext, interpolate: false
                }] };
            }
        } catch { if (!context.signal?.aborted) { warn(); } }
        return presentation;
    });

    // DSH 的 guard 必须同步返回。未返回拒绝理由时，DSH 继续按自己的策略执行。
    ctx.tools.guard(exec => {
        if (!edits.has(exec.name) || exec.signal?.aborted) { return; }
        try {
            const cwd = localDirectory(exec.agent);
            if (!cwd) { return; }
            const input = JSON.stringify({ hook_event_name: 'tools.guard', cwd, tool_name: exec.name, tool_input: exec.arguments });
            if (Buffer.byteLength(input) > maxBytes) { throw new Error(); }
            const result = output(execFileSync(config.runnerPath, args, { ...options, input, stdio: ['pipe', 'pipe', 'pipe'] }));
            if (result?.permissionDecision === 'deny') { return result.permissionDecisionReason; }
        } catch { warn(); }
    });
}
