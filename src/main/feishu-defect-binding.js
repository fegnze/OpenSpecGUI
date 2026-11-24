'use strict';

const fs = require('node:fs/promises');
const { constants, statSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { formValues, updateBinding } = require('./feishu-defect-settings');
const path = require('node:path');
const { readJson, writeJson } = require('./local-config');
const { checkSettings, validateWorkbenchValues: validate, BindingError } = require('../capabilities/skills/feishu-defect-agent/scripts/lib/workbench-binding.mjs');
const example = require('../capabilities/skills/feishu-defect-agent/assets/binding.example.json');

const MAX_BYTES = 512 * 1024;
function stamp(info) {
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

function fileStamp(file) {
    try { return stamp(statSync(file, { bigint: true })); }
    catch (error) { if (error.code === 'ENOENT') { return null; } throw error; }
}

async function readBinding(file) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.size > MAX_BYTES) { throw new BindingError('请选择 512 KiB 以内的普通 JSON 文件'); }
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) { break; }
            length += bytesRead;
        }
        if (length > MAX_BYTES) { throw new BindingError('绑定文件超过大小上限'); }
        let data;
        try { data = JSON.parse(buffer.toString('utf8', 0, length)); }
        catch { throw new BindingError('绑定文件不是有效 JSON'); }
        checkSettings(data, 0, true);
        const before = stamp(stat);
        if (before !== stamp(await handle.stat({ bigint: true }))) { throw new BindingError('文件读取期间已变化，请重新打开'); }
        return { data, digest: createHash('sha256').update(buffer.subarray(0, length)).digest('hex'), stamp: before };
    } finally { await handle.close(); }
}

function isWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

class FeishuDefectBinding {
    constructor({ userDataPath, getActive }) {
        this.data = path.resolve(userDataPath);
        this.getActive = getActive;
        this.writeQueue = Promise.resolve();
    }

    active(id) {
        const project = this.getActive();
        if (!id || !project || project.id !== id || !project.rootPath) { throw new Error('当前工作树已变化，请重新选择'); }
        return project;
    }

    async context(id) {
        const root = this.active(id).rootPath;
        if (await fs.realpath(root) !== root || !(await fs.stat(root)).isDirectory()) { throw new Error('当前工作树路径已失效'); }
        const key = createHash('sha256').update(root).digest('hex');
        const dir = path.join(this.data, 'feishu-defect-bindings', key);
        const check = () => {
            if (this.active(id).rootPath !== root) { throw new Error('当前工作树已变化，请重新选择'); }
        };
        check();
        return { id, root, dir, check, reference: path.join(dir, 'reference.json'), template: path.join(dir, 'binding.json') };
    }

    async directory(ctx) {
        if (isWithin(ctx.root, this.data)) { throw new Error('工作台用户目录必须位于业务工程之外'); }
        await fs.mkdir(this.data, { recursive: true, mode: 0o700 });
        const realData = await fs.realpath(this.data);
        if (isWithin(ctx.root, realData)) { throw new Error('工作台用户目录必须位于业务工程之外'); }
        let current = realData;
        for (const segment of ['feishu-defect-bindings', path.basename(ctx.dir)]) {
            current = path.join(current, segment);
            await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') { throw error; } });
            const stat = await fs.lstat(current);
            if (!stat.isDirectory()) { throw new Error('工作台绑定目录无效'); }
        }
        ctx.check();
    }

    enqueue(task) {
        const result = this.writeQueue.then(task);
        this.writeQueue = result.catch(() => {});
        return result;
    }

    async readState(ctx) {
        const refStamp = fileStamp(ctx.reference);
        const file = await this.selected(ctx);
        const source = file ? await readBinding(file) : null;
        const check = () => {
            ctx.check();
            if (fileStamp(ctx.reference) !== refStamp || (file && fileStamp(file) !== source.stamp)) {
                throw new Error('项目配置已变化，请重新打开表单');
            }
        };
        check();
        const revision = createHash('sha256').update(JSON.stringify([ctx.id, ctx.root, file, refStamp, source?.digest])).digest('hex');
        return { file, source, revision, check };
    }

    settingsResult(ctx, state) {
        let configured = false;
        let message = '请填写项目和缺陷来源。';
        if (state.source) {
            try { validate(state.source.data); configured = true; message = '本机项目配置已保存。账号与项目权限需单独验证。'; }
            catch (error) { message = error.message; }
        }
        return {
            projectId: ctx.id, configured, path: state.file, message, revision: state.revision,
            values: formValues(state.source?.data, ctx.root, state.file ? path.dirname(state.file) : ctx.root)
        };
    }

    async readSettings(projectId) {
        const ctx = await this.context(projectId);
        return this.settingsResult(ctx, await this.readState(ctx));
    }

    saveSettings(projectId, revision, values) {
        return this.enqueue(async () => {
            const ctx = await this.context(projectId);
            const before = await this.readState(ctx);
            if (typeof revision !== 'string' || revision !== before.revision) { throw new Error('项目配置已变化，请重新打开表单'); }
            const base = before.file ? path.dirname(before.file) : ctx.root;
            const binding = updateBinding(before.source?.data, values, ctx.root, base);
            validate(binding);
            if (Buffer.byteLength(JSON.stringify(binding)) > MAX_BYTES) { throw new Error('绑定文件超过大小上限'); }
            await this.directory(ctx);
            before.check();
            const managed = before.file && path.dirname(before.file) === ctx.dir &&
                (before.file === ctx.template || /^settings-[a-f0-9-]{36}\.json$/.test(path.basename(before.file)));
            if (managed) {
                await writeJson(before.file, binding, before.check);
            } else {
                const file = path.join(ctx.dir, 'settings-' + randomUUID() + '.json');
                await writeJson(file, binding, before.check);
                try { await writeJson(ctx.reference, { path: file }, before.check); }
                catch (error) { await fs.rm(file, { force: true }); throw error; }
            }
            return this.settingsResult(ctx, await this.readState(ctx));
        });
    }

    /** 旧版共用的工作树设置在首次使用时复制到本宿主，保留原有扩展字段。 */
    importLegacy(projectId, file) {
        return this.enqueue(async () => {
            const ctx = await this.context(projectId);
            if (await this.selected(ctx)) { return; }
            const { data } = await readBinding(file);
            validate(data);
            // 旧文件中的仓库相对路径仍应从它原来的目录解析。
            for (const repo of data.repositories || []) {
                if (repo.path) { repo.path = path.resolve(path.dirname(file), repo.path); }
            }
            await this.directory(ctx);
            const target = path.join(ctx.dir, 'settings-' + randomUUID() + '.json');
            await writeJson(target, data, ctx.check);
            try { await writeJson(ctx.reference, { path: target }, ctx.check); }
            catch (error) { await fs.rm(target, { force: true }); throw error; }
        });
    }

    async selected(ctx) {
        const reference = await readJson(ctx.reference, null);
        if (!reference) { return null; }
        if (typeof reference.path !== 'string' || !path.isAbsolute(reference.path) || path.extname(reference.path).toLowerCase() !== '.json') {
            throw new Error('工作台绑定记录无效，请重新选择文件');
        }
        return reference.path;
    }

    async describe(ctx, file) {
        let configured = false;
        let message = '请填写当前工作树使用的飞书项目和缺陷来源。';
        if (file) {
            try {
                validate((await readBinding(file)).data);
                configured = true;
                message = '绑定格式已检查。Skill 1.2.0 会自动读取当前工作树与宿主的设置。固定旧版请用 --binding 指定此文件，或升级到 1.2.0。';
            } catch (error) {
                message = error instanceof BindingError ? error.message : '绑定文件无法读取，请核对路径或重新选择。';
            }
        }
        ctx.check();
        return { projectId: ctx.id, configured, path: file, message };
    }

    async status(projectId) {
        const ctx = await this.context(projectId);
        return this.describe(ctx, await this.selected(ctx));
    }

    link(projectId, file) {
        return this.enqueue(() => this.linkNow(projectId, file));
    }

    async linkNow(projectId, file) {
        const ctx = await this.context(projectId);
        if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.json') {
            throw new Error('请选择单项目绑定 JSON 文件');
        }
        const result = await this.describe(ctx, file);
        if (!result.configured) { throw new Error(result.message); }
        await this.directory(ctx);
        await writeJson(ctx.reference, { path: file }, ctx.check);
        ctx.check();
        return result;
    }

    template(projectId) {
        return this.enqueue(() => this.templateNow(projectId));
    }

    async templateNow(projectId) {
        const ctx = await this.context(projectId);
        await this.directory(ctx);
        const sample = structuredClone(example);
        sample.repositories[0].path = ctx.root;
        try {
            await fs.writeFile(ctx.template, JSON.stringify(sample, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (error.code !== 'EEXIST') { throw error; }
            if (!(await fs.lstat(ctx.template)).isFile()) { throw new Error('工作台模板路径已被占用'); }
        }
        await writeJson(ctx.reference, { path: ctx.template }, ctx.check);
        return this.describe(ctx, ctx.template);
    }
}

module.exports = { FeishuDefectBinding };
