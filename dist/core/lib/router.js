/**
 * Conversation routing: one WeChat conversation maps to one DSH session, and the
 * user switches between them with in-chat commands.
 *
 * Why commands rather than a picker: WeChat gives a channel exactly one chat
 * surface, so a session list has to live inside the message stream. Tencent's own
 * client uses the same technique (it handles `/echo` and `/toggle-debug` in chat),
 * and the protocol's tool-call item types could eventually render something
 * richer. Commands work today, on every client, with no extra payload.
 *
 * Session ids are minted by this router in DSH's own format (`session-<uuid>`) and
 * handed to the session controller, which adopts an existing session with that id
 * or creates one. The mapping is what survives a restart, so a chat keeps talking
 * to the same session across reboots.
 *
 * @module @dsh-wechat/core/router
 */
import { randomUUID } from 'node:crypto';
import { compareSessionsNewestFirst, isSameWorkspace } from "./session-index.js";
/**
 * How long a binding must have existed before a `missing` verdict is believed.
 *
 * This is not a nicety; it is what a live run cost. The first version of this check replaced a
 * binding whenever the probe answered `missing`, and the machine immediately produced an endless
 * run of new sessions: a session has **no record on disk until its first turn writes one**, so every
 * message that arrived before that write judged the session it had just created to be missing, and
 * created another one. The user saw a new conversation per message.
 *
 * The age of the *binding* is what separates "its record is not written yet" from "it is actually
 * gone": the binding is created before the session's first prompt, so a young binding is expected to
 * be recordless, while an old one that still has no record is a session that has been deleted. Two
 * minutes is far longer than a first write takes and short enough that a deleted session is repaired
 * during the same exchange the user would otherwise have lost.
 *
 * `archived` is deliberately not subject to this. The archive set lives in the workspace registry,
 * which answers immediately and knows nothing about whether a record has been written yet — there is
 * no race here to be tolerant of, and an archived session never becomes usable by waiting.
 */
export const MISSING_BINDING_GRACE_MS = 2 * 60 * 1000;
/**
 * Order a listing so every branch sits under the conversation it was spawned from.
 *
 * A subagent session is a branch of the turn that created it, and the listing is where that
 * relationship belongs: the branch row is meaningless apart from its parent, and a flat
 * newest-first screen puts it at the top where the user reads it as an unrelated conversation.
 *
 * Rows keep the newest-first order they arrived in — this only moves a child to just below its
 * parent. The result is also the numbering: a number printed here is resolved against this array,
 * so the reorder and the reply agree by construction.
 *
 * @param rows - Rows sorted newest first, each optionally carrying `parentSession`.
 * @returns Rows in display order, children carrying `branch: true`.
 */
export function orderRowsWithBranches(rows) {
    const ids = new Set(rows.map((row) => row.sessionId));
    const children = new Map();
    const roots = [];
    for (const row of rows) {
        const parent = row.parentSession;
        if (parent !== undefined && parent !== row.sessionId && ids.has(parent)) {
            const list = children.get(parent);
            if (list === undefined)
                children.set(parent, [row]);
            else
                list.push(row);
            continue;
        }
        roots.push(row);
    }
    const ordered = [];
    const seen = new Set();
    const visit = (row, branch) => {
        if (seen.has(row.sessionId))
            return;
        seen.add(row.sessionId);
        ordered.push(branch ? { ...row, branch: true } : row);
        for (const child of children.get(row.sessionId) ?? [])
            visit(child, true);
    };
    for (const root of roots)
        visit(root, false);
    // A cycle (or a parent that only exists outside this folder) must not hide a row: anything
    // unreachable is appended in its original position order.
    for (const row of rows)
        visit(row, false);
    return ordered;
}
/**
 * Routes WeChat messages to DSH sessions and implements the in-chat commands.
 */
export class SessionRouter {
    #gateway;
    #store;
    #titlePrefix;
    #ownWorkspace;
    #ownWorkspaceLabel;
    #onDiagnostic;
    #bindings;
    #labels;
    #excerptChars = 50;
    constructor(options) {
        this.#gateway = options.gateway;
        this.#store = options.store;
        this.#titlePrefix = options.titlePrefix ?? '微信';
        this.#ownWorkspace = options.ownWorkspace;
        this.#ownWorkspaceLabel = options.ownWorkspaceLabel ?? '微信会话';
        this.#onDiagnostic = options.onDiagnostic;
        this.#labels = options.labels instanceof Map ? options.labels : new Map(Object.entries(options.labels ?? {}));
    }
    /**
     * Route one inbound message.
     *
     * @param params.conversationId - Stable conversation key.
     * @param params.accountId - Bot account the message arrived on.
     * @param params.peerId - Counterparty user id.
     * @param params.text - Message text.
     * @param params.numbered - The rows a bare number refers to, when the caller knows of a listing the
     *   user is looking at — a quoted list, or the newest one sent into this conversation.
     * @param params.heldHint - Wording for the "there are more conversations elsewhere" sentence, which
     *   differs between a typed `/list` and a spoken request.
     * @param params.browse - Where this conversation was left in the listing browser, when it is
     *   somewhere. Without it a bare number is an ordinary message, as it always was.
     * @returns Either text to reply with directly, or a prompt for a session. A prompt decision may
     *   carry a `notice` when the conversation had to be moved to a new session first — see
     *   {@link SessionGateway.sessionState}.
     */
    async route(params) {
        const text = params.text.trim();
        if (params.labels !== undefined) {
            this.#labels = params.labels instanceof Map ? params.labels : new Map(Object.entries(params.labels ?? {}));
        }
        if (Number.isSafeInteger(params.excerptChars))
            this.#excerptChars = params.excerptChars;
        // A message that starts with `/` is a command. The trigger character used to be configurable;
        // it is fixed now, so the agent's natural-language tools and every old name keep working.
        if (text.startsWith('/')) {
            return await this.#command(params, text);
        }
        /*
         * A reply to a listing is answered here, before the agent is woken.
         *
         * It has to be, because the browsing position is the channel's own bookkeeping: the agent sees
         * "2" and has no way to know whether that means a folder, a conversation, or the answer to
         * something it asked. The router does know, so it decides — and returns nothing when the message
         * is not a step at all, which keeps an ordinary remark during a listing on its way to the agent.
         */
        if (params.browse?.level === 'modes' && text !== '') {
            const modeBindings = await this.#load();
            const modeBinding = modeBindings[params.conversationId];
            if (modeBinding !== undefined && this.#gateway.modeInfo !== undefined) {
                try {
                    const info = await this.#gateway.modeInfo(modeBinding.sessionId);
                    const numeric = /^\d+$/.test(text);
                    const byName = info.available.some((preset) => preset.name === text || preset.id === text);
                    if (numeric || byName)
                        return await this.#modeReply(modeBinding, text);
                }
                catch {
                    // Not a mode step after all; an ordinary message goes to the agent.
                }
            }
        }
        if (params.browse !== undefined && text !== '') {
            const browsed = await this.#browseReply(params, text, params.browse);
            if (browsed !== undefined)
                return browsed;
        }
        const bindings = await this.#load();
        let binding = bindings[params.conversationId];
        let created = false;
        let notice;
        if (binding === undefined) {
            binding = await this.#bind(params, undefined);
            created = true;
        }
        else {
            /*
             * Ask whether the bound session still works *before* reusing it.
             *
             * Both ways it can be dead are silent from here on down: an archived session accepts the
             * prompt and then has its step rejected, and a session gone from disk receives nothing. The
             * message is then lost with no reply from the phone's point of view and no line in any log,
             * and there is nothing the user can do about it — which is what this check is for.
             */
            const dead = await this.#deadState(binding);
            if (dead !== undefined) {
                /*
                 * A dead binding is replaced rather than repaired or unarchived.
                 *
                 * The conversation has to keep working, and the one thing that is definitely still usable is
                 * a session this channel creates itself; unarchiving would be the plugin reaching into a
                 * decision the user made on the desktop, and a session deleted on disk has nothing left to
                 * repair. `/switch` is still there for anyone who wants the old conversation back.
                 */
                const previous = binding;
                binding = await this.#bind(params, undefined);
                created = true;
                notice = replacedBindingNotice(previous.title, dead, binding.title);
                this.#diagnose(`session-state: binding moved conversation=${params.conversationId} ` +
                    `from=${previous.sessionId} to=${binding.sessionId} state=${dead} ` +
                    `bindingAge=${String(Math.round((Date.now() - previous.createdAt) / 1000))}s`);
            }
            else {
                // DSH may have restarted since this binding was made; make sure the session
                // is live before handing it a prompt.
                await this.#gateway.ensureSession(binding.sessionId, binding.title);
            }
        }
        binding.lastUsedAt = Date.now();
        await this.#store.save(bindings);
        return {
            kind: 'prompt',
            decision: {
                sessionId: binding.sessionId,
                prompt: text,
                created,
                ...(notice === undefined ? {} : { notice }),
            },
        };
    }
    /** Currently bound session for a conversation, if any. */
    async current(conversationId) {
        return (await this.#load())[conversationId];
    }
    async #command(params, text) {
        const { command, args } = splitCommand(normalizeCommandText(text, params.aliases));
        const bindings = await this.#load();
        const binding = bindings[params.conversationId];
        const all = await this.#gateway.listSessions();
        const own = await this.#ownSessions(all);
        switch (command) {
            case '/help':
                return { kind: 'reply', text: helpText(), screen: commandScreen() };
            case '/workspaces':
            case '/workspace': {
                const folderName = args.trim();
                if (folderName === '')
                    return this.#workspaceReply(all);
                const folders = this.#folders(all);
                const folder = resolveFolder(folderName, folders);
                if (folder.kind === 'found')
                    return this.#folderSessionsReply(params, folder.folder, all, own, binding?.sessionId, params.heldHint, 1, Date.now());
                if (folder.kind === 'ambiguous')
                    return { kind: 'reply', text: ambiguousFolderMessage(folderName, folder.candidates, folders) };
                if (folder.kind === 'unprinted')
                    return { kind: 'reply', text: unprintedFolderMessage(folder.number, folder.count) };
                return { kind: 'reply', text: `找不到工作区「${folderName}」。回复「/工作区列表」看全部。` };
            }
            case '/sessions':
            case '/list':
                return this.#sessionListReply(params, all, own, binding);
            case '/switch':
                return await this.#switchCommand(params, args.trim(), all, own, binding);
            case '/send':
                return await this.#sendReply(params, args.trim(), all, own);
            case '/new':
                return await this.#newReply(params, args.trim());
            case '/model':
                return await this.#modelReply(binding, args.trim());
            case '/permission':
                return await this.#permissionReply(binding, args.trim());
            case '/mode':
                return await this.#modeReply(binding, args.trim());
            case '/history':
                return await this.#historyReply(binding, args.trim());
            case '/current':
                return await this.#currentReply(binding);
            case '/wait':
                return { kind: 'reply', text: '已经处在等待状态：这期间发的文字和文件都会暂存，发「/完成」才一起交给模型。' };
            case '/done':
                return { kind: 'reply', text: '没有暂存的消息。先发「/等待」再发内容，最后发「/完成」。' };
            case '/more':
                return await this.#moreReply(params);
            case '/continue':
                return { kind: 'reply', text: '已刷新回复窗口，继续发送。' };
            case '/cancel': {
                if (binding === undefined)
                    return { kind: 'reply', text: '当前没有对话。' };
                await this.#gateway.cancel(binding.sessionId);
                return { kind: 'reply', text: '已请求中断当前任务。' };
            }
            default:
                return { kind: 'reply', text: `未知指令 ${command}。\n\n${helpText()}` };
        }
    }
    /** A reply that is both plain text and an info card. */
    #infoReply(text, info) {
        return { kind: 'reply', text, screen: { level: 'info', info } };
    }
    /** The workspace listing: the first screen of the browser. */
    #workspaceReply(all, footer = '回复「/切换 工作区」进入 · 回复「/会话列表」看当前工作区') {
        const folders = this.#folders(all);
        if (folders.length === 0)
            return { kind: 'reply', text: '还没有任何对话，直接发消息就会新建一个。' };
        const pages = Math.max(1, Math.ceil(folders.length / BROWSE_PAGE_SIZE));
        const shown = Math.min(pages, MAX_LIST_CARDS);
        const screens = [];
        for (let page = 1; page <= shown; page += 1)
            screens.push({ ...folderScreen(folders, page), footer });
        const first = renderFolderScreen(folders, 1);
        return {
            kind: 'reply',
            text: shown < pages ? `${first}\n\n共 ${pages} 页，回复「/其余」继续。` : first,
            screen: screens[0],
            screens,
            browse: { level: 'folders', workspace: '', page: shown, at: Date.now() },
        };
    }
    /** This conversation's workspace: the second screen of the browser. */
    #sessionListReply(params, all, own, binding) {
        /*
         * List the workspace the bound conversation lives in, not the channel's own directory.
         *
         * The old version always asked for the channel's folder, which is why `/会话列表` kept showing
         * the WeChat workspace even after the conversation had been switched to a desktop project.
         */
        let path = '';
        if (binding !== undefined) {
            const row = all.find((session) => session.sessionId === binding.sessionId);
            if (row !== undefined && row.workspace !== undefined)
                path = row.workspace;
        }
        const label = this.#folderLabel(path);
        const rows = this.#rowsIn(path, all, own);
        if (rows.length === 0) {
            if (this.#isOwnFolder(path)) {
                const ownIds = new Set(own.map((session) => session.sessionId));
                const held = all.filter((session) => !ownIds.has(session.sessionId));
                if (held.length === 0)
                    return { kind: 'reply', text: '还没有任何对话，直接发消息就会新建一个。' };
                return { kind: 'reply', text: heldOnlyList(held, this.#ownWorkspaceLabel) };
            }
            return { kind: 'reply', text: `「${label}」还没有对话。` };
        }
        const pages = Math.max(1, Math.ceil(rows.length / BROWSE_PAGE_SIZE));
        const shown = Math.min(pages, MAX_LIST_CARDS);
        const options = {
            label,
            total: rows.length,
            ...(binding === undefined ? {} : { currentId: binding.sessionId }),
            ...(this.#isOwnFolder(path) ? this.#heldHintFor(own, all, params.heldHint) : {}),
        };
        const screens = [];
        for (let page = 1; page <= shown; page += 1) {
            const rendered = renderSessionScreen(rows, { ...options, page });
            screens.push({ screen: rendered.screen, numbered: rendered.numbered });
        }
        const first = renderSessionScreen(rows, { ...options, page: 1 });
        return {
            kind: 'reply',
            text: shown < pages ? `${first.text}\n\n共 ${pages} 页，回复「/其余」继续。` : first.text,
            numbered: first.numbered,
            screen: screens[0].screen,
            screens,
            browse: { level: 'sessions', workspace: path, page: shown, at: Date.now() },
        };
    }
    /**
     * `/切换`: bare opens the workspace list, a workspace opens its conversations without moving the
     * chat, a session moves the chat, and `工作区-会话` does both at once.
     */
    async #switchCommand(params, value, all, own, binding) {
        if (value === '')
            return this.#workspaceReply(all, '回复「/切换 工作区」进入 · 回复「/切换 工作区-会话」直接切换');
        const folders = this.#folders(all);
        /*
         * `工作区-会话` is tried before the folder match, because a folder match is deliberately lenient
         * (a fragment of the name counts). Without this order `插件开发-会话乙` would match the folder
         * `插件开发` and only open its listing instead of switching.
         */
        const joined = this.#splitWorkspaceSession(value, folders, all, own);
        if (joined !== undefined)
            return await this.#bindToSession(params, joined.session);
        const byFolder = resolveFolder(value, folders);
        if (byFolder.kind === 'ambiguous')
            return { kind: 'reply', text: ambiguousFolderMessage(value, byFolder.candidates, folders) };
        if (byFolder.kind === 'unprinted')
            return { kind: 'reply', text: unprintedFolderMessage(byFolder.number, byFolder.count) };
        if (byFolder.kind === 'found')
            return this.#folderSessionsReply(params, byFolder.folder, all, own, binding?.sessionId, params.heldHint, 1, Date.now());
        const switched = await this.#switchTo(params, value, { mode: 'command' });
        return switched ?? { kind: 'reply', text: UNKNOWN_TARGET };
    }
    /** Split `工作区-会话` into a folder and a session, when both halves resolve. */
    #splitWorkspaceSession(value, folders, all, own) {
        for (let index = value.length - 1; index > 0; index -= 1) {
            if (value[index] !== '-')
                continue;
            const folderName = value.slice(0, index).trim();
            const sessionName = value.slice(index + 1).trim();
            if (folderName === '' || sessionName === '')
                continue;
            const folder = resolveFolder(folderName, folders);
            if (folder.kind !== 'found')
                continue;
            const resolution = resolveTarget(sessionName, this.#rowsIn(folder.folder.path, all, own));
            if (resolution.kind === 'found')
                return { folder: folder.folder, session: resolution.session };
        }
        return undefined;
    }
    /**
     * `/发送`: either the whole address book as a Markdown file, or aim the next message at one session.
     *
     * The listing intentionally mirrors the cards: workspace numbers are the folder order, session
     * numbers are the order inside that folder, so a number read off a card is the number this
     * command accepts. With an argument it arms a one-shot target instead of switching: the channel
     * keeps the current conversation and hands only the next message to the chosen session.
     *
     * @param params - Route parameters (conversation id is where the target is armed).
     * @param value - `''` for the file, otherwise `工作区-会话` by name or `编号-编号`.
     * @param all - Every conversation the machine knows.
     * @param own - The channel's own conversations.
     * @returns Reply with the Markdown file, or with the target card.
     */
    async #sendReply(params, value, all, own) {
        const folders = this.#folders(all);
        if (value === '') {
            const lines = ['# 全部工作区与会话', ''];
            for (let folderIndex = 0; folderIndex < folders.length; folderIndex += 1) {
                const folder = folders[folderIndex];
                lines.push(`## ${folderIndex + 1}. ${folder.label}`);
                const rows = this.#rowsIn(folder.path, all, own);
                if (rows.length === 0)
                    lines.push('（没有会话）');
                for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
                    const session = rows[rowIndex];
                    const answer = await this.#lastAnswerExcerpt(session.sessionId, 20);
                    lines.push(`${rowIndex + 1}. ${session.title} · ${relativeTime(session.updatedAt)}` +
                        `${answer === '' ? '' : ` · 最近回答：${answer}`}`);
                }
                lines.push('');
            }
            const name = `会话清单-${fileNameStamp(Date.now())}.md`;
            return {
                kind: 'reply',
                text: '已生成全部工作区与会话清单（md）。',
                file: { name, content: `${lines.join('\n')}\n` },
            };
        }
        const target = this.#resolveSendTarget(value, folders, all, own);
        if (target === undefined)
            return { kind: 'reply', text: `找不到会话「${value}」。回复「/发送」看全部工作区与会话。` };
        await this.#gateway.setSendTarget?.(params.conversationId, {
            sessionId: target.session.sessionId,
            title: target.session.title,
            workspaceName: target.folder.label,
            at: Date.now(),
        });
        const excerpt = await this.#lastAnswerExcerpt(target.session.sessionId, 20);
        return {
            kind: 'reply',
            text: `下一条消息会发送给「${target.session.title}」（${target.folder.label}）。\n` +
                '不会切换当前会话。',
            screen: {
                level: 'info',
                info: {
                    header: 'DeepSeek Harness微信端 · 发送',
                    badge: '下一条消息',
                    title: target.session.title,
                    subtitle: `${target.folder.label} · ${relativeTime(target.session.updatedAt)}`,
                    rows: [
                        { label: '工作区', value: target.folder.label },
                        { label: '会话', value: target.session.title },
                        ...(excerpt === '' ? [] : [{ label: '最近回答', value: excerpt }]),
                    ],
                    footer: '下一条消息只发给这个会话，不切换当前对话；先 /等待 打包内容，再 /完成 也会发到这里。',
                },
            },
        };
    }
    /**
     * Resolve the `工作区-会话` argument of `/发送`.
     *
     * Numbers first, because that is what the address book lists; names are accepted as a fallback so
     * the command still reads naturally. A bare session name is only used when exactly one folder has
     * a match, since guessing between two same-named sessions would send the message to the wrong one.
     */
    #resolveSendTarget(value, folders, all, own) {
        const trimmed = value.trim();
        const byNumber = /^(\d+)\s*[-:：]\s*(\d+)$/.exec(trimmed);
        if (byNumber !== null) {
            const folder = folders[Number(byNumber[1]) - 1];
            if (folder === undefined)
                return undefined;
            const session = this.#rowsIn(folder.path, all, own)[Number(byNumber[2]) - 1];
            return session === undefined ? undefined : { folder, session };
        }
        const joined = this.#splitWorkspaceSession(trimmed, folders, all, own);
        if (joined !== undefined)
            return joined;
        const matches = [];
        for (const folder of folders) {
            const resolution = resolveTarget(trimmed, this.#rowsIn(folder.path, all, own));
            if (resolution.kind === 'found')
                matches.push({ folder, session: resolution.session });
        }
        return matches.length === 1 ? matches[0] : undefined;
    }
    /** The newest answer of a session, cut for a listing line. */
    async #lastAnswerExcerpt(sessionId, chars) {
        if (chars <= 0 || this.#gateway.lastAnswer === undefined)
            return '';
        try {
            const text = await this.#gateway.lastAnswer(sessionId, chars);
            return typeof text === 'string' ? text.trim() : '';
        }
        catch {
            return '';
        }
    }
    /** The card shown after any switch: the session, what it runs as, and its newest answer. */
    async #switchCard(binding, lead) {
        let info;
        try {
            info = this.#gateway.currentInfo === undefined ? undefined : await this.#gateway.currentInfo(binding.sessionId);
        }
        catch {
            info = undefined;
        }
        let excerpt;
        if (this.#excerptChars > 0 && this.#gateway.lastAnswer !== undefined) {
            try {
                excerpt = await this.#gateway.lastAnswer(binding.sessionId, this.#excerptChars);
            }
            catch {
                excerpt = undefined;
            }
        }
        const model = info === undefined || info.modelName === undefined
            ? '默认'
            : `${info.modelName}${info.levelName === undefined || info.levelName === '' ? '' : ` · ${info.levelName}`}`;
        const rows = [
            { label: '模型', value: model },
            { label: '权限', value: info?.permissionLabel ?? '未知' },
            { label: '模式', value: info?.modeName ?? '未知' },
            ...(excerpt === undefined || excerpt === '' ? [] : [{ label: '最近回答', value: excerpt }]),
        ];
        const text = [lead, shortId(binding.sessionId), `模型：${model}`].join('\n');
        return this.#infoReply(text, {
            header: 'DeepSeek Harness微信端 · 会话',
            badge: shortId(binding.sessionId),
            title: binding.title,
            ...(info?.workspaceName === undefined ? {} : { subtitle: `工作区：${info.workspaceName}` }),
            rows,
            footer: '回复「/会话列表」看别的会话 · 回复「/当前」再看一次',
        });
    }
    /** Move this conversation onto one session and say so. */
    async #bindToSession(params, target) {
        const bindings = await this.#load();
        await this.#gateway.ensureSession(target.sessionId, target.title);
        const binding = {
            conversationId: params.conversationId,
            accountId: params.accountId,
            peerId: params.peerId,
            sessionId: target.sessionId,
            title: target.title || this.#titlePrefix,
            createdAt: bindings[params.conversationId]?.createdAt ?? Date.now(),
            lastUsedAt: Date.now(),
        };
        bindings[params.conversationId] = binding;
        await this.#store.save(bindings);
        return await this.#switchCard(binding, '已切换到会话「' + binding.title + '」。');
    }
    /** `/新会话`: create and bind immediately, then show what it will run as. */
    async #newReply(params, title) {
        const binding = await this.#bind(params, title || undefined);
        const bindings = await this.#load();
        bindings[params.conversationId] = binding;
        await this.#store.save(bindings);
        const info = this.#gateway.currentInfo === undefined
            ? undefined
            : await this.#gateway.currentInfo(binding.sessionId);
        const rows = [
            { label: '工作区', value: info?.workspaceName ?? this.#ownWorkspaceLabel },
            { label: '模式', value: info?.modeName ?? '默认' },
            {
                label: '模型',
                value: info === undefined
                    ? '默认'
                    : `${info.modelName ?? '默认'}${info.levelName === undefined || info.levelName === '' ? '' : ` · ${info.levelName}`}`,
            },
        ];
        const text = [
            `已新建会话「${binding.title}」。`,
            shortId(binding.sessionId),
            '还没开始聊天，可以继续用「/模式 名称」改模式；开始聊天后模式就锁定了。',
        ].join('\n');
        return this.#infoReply(text, {
            header: 'DeepSeek Harness微信端 · 新会话',
            badge: shortId(binding.sessionId),
            title: binding.title,
            subtitle: '模式在开始聊天前仍可修改',
            rows,
            footer: '回复「/模式 名称」改模式 · 直接发消息就开始聊天',
        });
    }
    /** `/模型`: the catalog as a card, or a switch of the bound conversation's model and level. */
    async #modelReply(binding, value) {
        if (this.#gateway.listModels === undefined)
            return { kind: 'reply', text: '当前组合没有模型列表，无法查看或切换模型。' };
        const listing = await this.#gateway.listModels(binding?.sessionId);
        const models = listing.models ?? [];
        if (value === '') {
            const currentLabel = modelInUseLabel(listing, models);
            const rows = models.map((model, index) => ({
                label: String(index + 1),
                value: `${model.name ?? model.model}${sameModel(listing.current, model) ? '  ← 当前' : ''}`,
                note: (model.levels ?? []).length === 0
                    ? `${model.providerName} · ${model.model}`
                    : `推理等级：${(model.levels ?? []).map((level) => level.name).join(' · ')}`,
                accent: sameModel(listing.current, model),
            }));
            for (const failure of listing.failures ?? [])
                rows.push({ label: '!', value: `${failure.name}：${failure.message}` });
            return this.#infoReply(renderModelList(listing), {
                header: 'DeepSeek Harness微信端 · 模型',
                badge: `共 ${models.length} 个`,
                title: '模型与思考等级',
                ...(currentLabel === undefined ? {} : { subtitle: `当前：${currentLabel}` }),
                rows,
                emptyText: '没有可用的模型',
                footer: '回复「/模型 编号」切换 · 回复「/模型 编号-等级」同时换等级',
            });
        }
        if (binding === undefined)
            return { kind: 'reply', text: '当前没有对话。先发一条消息新建一个，再切模型。' };
        if (this.#gateway.selectModel === undefined)
            return { kind: 'reply', text: '当前组合不支持切换模型。' };
        const asked = splitModelLevel(value, models);
        const chosen = resolveModelOption(asked.target, models);
        if (chosen === undefined)
            return { kind: 'reply', text: `${NOT_FOUND_MODEL}「${asked.target}」。回复 /model 看清单，再回复编号或模型名字。` };
        const levels = chosen.levels ?? [];
        let levelId = chosen.defaultLevel;
        let levelLabel;
        if (asked.level !== undefined) {
            const found = resolveLevel(asked.level, levels);
            if (found === undefined)
                return {
                    kind: 'reply',
                    text: `${NOT_FOUND_LEVEL}「${asked.level}」。${chosen.name} 可以用的推理等级：${levels.map((level) => level.name).join('、')}。`,
                };
            levelId = found.id;
            levelLabel = found.name;
        }
        try {
            const selected = await this.#gateway.selectModel(binding.sessionId, chosen.provider, chosen.model, levelId);
            const label = levelName(selected.reasoningEffort, levels) ?? levelLabel;
            return {
                kind: 'reply',
                text: `已把会话「${binding.title}」切换到 ${chosen.name}（${chosen.providerName}）` +
                    `${label === undefined ? '' : ` · 思考等级 ${label}`}。`,
            };
        }
        catch (error) {
            return { kind: 'reply', text: `${FAILED_MODEL}：${reasonOf(error)}` };
        }
    }
    /** `/权限`: the presets as a card, or one preset applied by name. */
    async #permissionReply(binding, value) {
        if (this.#gateway.permissionInfo === undefined)
            return { kind: 'reply', text: '当前组合没有权限预设服务。' };
        if (binding === undefined)
            return { kind: 'reply', text: '当前没有对话。先发一条消息新建一个，再切换权限。' };
        try {
            if (value === '') {
                const info = await this.#gateway.permissionInfo(binding.sessionId);
                return this.#infoReply(permissionText(info, binding.title), {
                    header: 'DeepSeek Harness微信端 · 权限',
                    badge: binding.title,
                    title: '会话权限',
                    subtitle: `当前：${info.current.label}`,
                    rows: info.available.map((preset) => ({
                        label: preset.label,
                        value: preset.id,
                        note: preset.description,
                        accent: preset.id === info.current.id,
                    })),
                    footer: '回复「/权限 名称」修改 · 放宽权限只影响之后的操作',
                });
            }
            if (this.#gateway.setPermission === undefined)
                return { kind: 'reply', text: '当前组合不支持修改权限。' };
            const applied = await this.#gateway.setPermission(binding.sessionId, value);
            if (applied.ok !== true)
                return { kind: 'reply', text: applied.text };
            return { kind: 'reply', text: `会话「${binding.title}」的权限已修改为${applied.label}。` };
        }
        catch (error) {
            return { kind: 'reply', text: `查看或切换权限失败：${reasonOf(error)}` };
        }
    }
    /** `/模式`: the agent presets as a card, or one preset applied by name. */
    async #modeReply(binding, value) {
        if (this.#gateway.modeInfo === undefined)
            return { kind: 'reply', text: '当前组合没有模式（Agent 预设）服务。' };
        if (binding === undefined)
            return { kind: 'reply', text: '当前没有对话。先发一条消息新建一个，再切换模式。' };
        try {
            let asked = value;
            if (/^\d+$/.test(value)) {
                const info = await this.#gateway.modeInfo(binding.sessionId);
                const chosen = info.available[Number(value) - 1];
                if (chosen === undefined)
                    return { kind: 'reply', text: `没有编号 ${value} 的模式。回复「/模式」查看全部。` };
                asked = chosen.name;
            }
            if (asked === '') {
                const info = await this.#gateway.modeInfo(binding.sessionId);
                return {
                    ...this.#infoReply(modeText(info, binding.title), {
                        header: 'DeepSeek Harness微信端 · 模式',
                        badge: binding.title,
                        title: '会话模式',
                        subtitle: `当前：${info.current.name}`,
                        rows: info.available.map((preset, index) => ({
                            label: String(index + 1),
                            value: preset.name,
                            note: preset.description,
                            accent: preset.id === info.current.id,
                        })),
                        footer: '回复编号或名称修改 · 模式只能在还没开始聊天的会话里换',
                    }),
                    browse: { level: 'modes', at: Date.now() },
                };
            }
            if (this.#gateway.setMode === undefined)
                return { kind: 'reply', text: '当前组合不支持修改模式。' };
            const applied = await this.#gateway.setMode(binding.sessionId, asked);
            if (applied.ok !== true)
                return { kind: 'reply', text: applied.text };
            return { kind: 'reply', text: `会话「${binding.title}」的模式已修改为${applied.label}。` };
        }
        catch (error) {
            return { kind: 'reply', text: `查看或切换模式失败：${reasonOf(error)}` };
        }
    }
    /** `/聊天记录`: the statistics card, or a markdown export of the newest N entries. */
    async #historyReply(binding, value) {
        if (binding === undefined)
            return { kind: 'reply', text: '当前没有对话，没有聊天记录。' };
        if (value === '') {
            if (this.#gateway.historyStats === undefined)
                return { kind: 'reply', text: '当前组合不支持统计聊天记录。' };
            try {
                const stats = await this.#gateway.historyStats(binding.sessionId);
                return this.#infoReply(historyText(stats, binding.title), {
                    header: 'DeepSeek Harness微信端 · 聊天记录',
                    badge: binding.title,
                    title: '会话统计',
                    subtitle: `共 ${stats.turns ?? 0} 条聊天`,
                    rows: [
                        { label: '总聊天次数', value: `${stats.turns ?? 0} 条` },
                        {
                            label: '上下文比例',
                            value: stats.contextPercent === undefined ? '—' : `${Math.round(stats.contextPercent)}%`,
                            ...(stats.contextTokens === undefined || stats.contextWindow === undefined
                                ? {}
                                : { note: `${stats.contextTokens} / ${stats.contextWindow} token` }),
                        },
                        { label: '计费 token', value: stats.tokens === undefined ? '—' : stats.tokens.toLocaleString('en-US') },
                        { label: '第一次聊天', value: stampText(stats.firstAt) || '—' },
                        { label: '最后一次', value: stampText(stats.lastAt) || '—' },
                    ],
                    footer: '回复「/聊天记录 50」导出最近 50 条 · 条数＝用户一条＋回复一条',
                });
            }
            catch (error) {
                return { kind: 'reply', text: `统计聊天记录失败：${reasonOf(error)}` };
            }
        }
        if (this.#gateway.history === undefined)
            return { kind: 'reply', text: '当前组合不支持导出聊天记录。' };
        const count = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(count) || count <= 0)
            return { kind: 'reply', text: '「/聊天记录」后面跟条数，例如 /聊天记录 50。' };
        try {
            const exported = await this.#gateway.history(binding.sessionId, Math.min(count, 100));
            const safeTitle = binding.title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 30) || '会话';
            const name = `聊天记录-${safeTitle}-${exported.count}-${fileNameStamp(Date.now())}.md`;
            return {
                kind: 'reply',
                text: exported.count === 0
                    ? '最近的对话里没有可以导出的消息。'
                    : `聊天记录已导出：${exported.count} 条，见下面的 md 文件。`,
                ...(exported.count === 0 ? {} : { file: { name, content: exported.content } }),
            };
        }
        catch (error) {
            return { kind: 'reply', text: `导出聊天记录失败：${reasonOf(error)}` };
        }
    }
    /** `/当前`: the bound conversation as a card. */
    async #currentReply(binding) {
        if (binding === undefined)
            return { kind: 'reply', text: '当前没有对话，发任意消息就会新建一个。' };
        if (this.#gateway.currentInfo === undefined)
            return { kind: 'reply', text: `当前对话「${binding.title}」\n${shortId(binding.sessionId)}` };
        try {
            const info = await this.#gateway.currentInfo(binding.sessionId);
            const excerpt = this.#excerptChars > 0 && info.lastAnswer !== undefined
                ? String(info.lastAnswer).slice(0, this.#excerptChars)
                : undefined;
            const model = info.modelName === undefined
                ? '默认'
                : `${info.modelName}${info.levelName === undefined || info.levelName === '' ? '' : ` · ${info.levelName}`}`;
            const rows = [
                { label: '模型', value: model },
                { label: '权限', value: info.permissionLabel ?? '未知' },
                { label: '模式', value: info.modeName ?? '未知' },
                ...(excerpt === undefined ? [] : [{ label: '最近回答', value: excerpt }]),
            ];
            const text = [
                `当前会话「${binding.title}」`,
                shortId(binding.sessionId),
                `模型：${model}`,
                `权限：${info.permissionLabel ?? '未知'}`,
                `模式：${info.modeName ?? '未知'}`,
            ].join('\n');
            return this.#infoReply(text, {
                header: 'DeepSeek Harness微信端 · 当前',
                badge: shortId(binding.sessionId),
                title: binding.title,
                subtitle: `工作区：${info.workspaceName ?? this.#ownWorkspaceLabel}`,
                rows,
                footer: '回复「/会话列表」看别的会话 · 回复「/模型」换模型',
            });
        }
        catch (error) {
            return { kind: 'reply', text: `读取当前会话信息失败：${reasonOf(error)}` };
        }
    }
    /**
     * Answer the `/model 等级 …` half: name a model's levels, or move the conversation onto one.
     *
     * A level is a property of a *model*, so both halves need one resolved: the model the user named
     * (`/model 2 等级 高`), or the one already in use (`/model 等级 高`), which is the shorter thing to
     * type when only the level changes. Changing the level of a model the conversation is not on is
     * therefore a model switch that also names the level, and is reported as one.
     *
     * @param binding - Its binding, absent when the conversation has never spoken.
     * @param listing - The catalog, with the selection the host reported as current.
     * @param asked - The parsed `/model` argument.
     */
    async #selectLevel(binding, listing, asked) {
        const current = listing.current;
        const option = asked.target === ''
            ? current === undefined
                ? undefined
                : listing.models.find((entry) => entry.provider === current.provider && entry.model === current.model)
            : resolveModelOption(asked.target, listing.models);
        if (option === undefined && asked.target !== '') {
            return {
                kind: 'reply',
                text: `${NOT_FOUND_MODEL}「${asked.target}」。回复 /model 看清单，再回复编号或模型名字。`,
            };
        }
        const levels = option?.levels ?? [];
        if (option === undefined || levels.length === 0) {
            /*
             * Three ways to get here — no model selected yet, a current model the catalog no longer offers,
             * and a model that genuinely has no levels — and one answer for all three. They are the same
             * thing to the user: there is no level to switch, and the next step is to look at the list.
             */
            return { kind: 'reply', text: `${NO_LEVELS}。回复 /model 看清单。` };
        }
        if (asked.level === undefined) {
            // A question about one model's levels needs no binding: nothing is being changed.
            return { kind: 'reply', text: renderLevels(option, current, levels) };
        }
        const level = resolveLevel(asked.level, levels);
        if (level === undefined) {
            // The valid set is printed, because a level id the adapter does not publish is not something
            // the user can guess their way to — and the set is small enough to show in full.
            return {
                kind: 'reply',
                text: `${NOT_FOUND_LEVEL}「${asked.level}」。${option.name} 可以用的推理等级：` +
                    `${levels.map((entry) => entry.name).join('、')}。`,
            };
        }
        if (binding === undefined) {
            return { kind: 'reply', text: '当前没有对话。先发一条消息新建一个，再切推理等级。' };
        }
        if (this.#gateway.selectModel === undefined) {
            return { kind: 'reply', text: '当前组合不支持切换推理等级。' };
        }
        const sameModel = current !== undefined && current.provider === option.provider && current.model === option.model;
        try {
            const selected = await this.#gateway.selectModel(binding.sessionId, option.provider, option.model, level.id);
            // The host normalises the level it installed, so the label is looked up from what came back
            // rather than from what was asked for: those differ exactly when the host decided otherwise.
            const label = levelName(selected.reasoningEffort, levels) ?? level.name;
            return {
                kind: 'reply',
                text: sameModel
                    ? `已把「${binding.title}」的推理等级切到 ${label}（${option.name}）。`
                    : [
                        `已把「${binding.title}」切换到 ${option.name}（${option.providerName}）。`,
                        `推理等级：${label}`,
                        selected.model,
                    ].join('\n'),
            };
        }
        catch (error) {
            const what = sameModel ? FAILED_LEVEL : FAILED_MODEL;
            return { kind: 'reply', text: `${what}：${reasonOf(error)}` };
        }
    }
    /** Create a binding, its session, and persist it. */
    async #bind(params, requestedTitle) {
        const bindings = await this.#load();
        const sessionId = mintSessionId();
        const title = requestedTitle?.trim() || `${this.#titlePrefix} ${shortId(sessionId)}`;
        await this.#gateway.ensureSession(sessionId, title);
        const now = Date.now();
        const binding = {
            conversationId: params.conversationId,
            accountId: params.accountId,
            peerId: params.peerId,
            sessionId,
            title,
            createdAt: now,
            lastUsedAt: now,
        };
        bindings[params.conversationId] = binding;
        await this.#store.save(bindings);
        return binding;
    }
    async #load() {
        this.#bindings ??= await this.#store.load();
        return this.#bindings;
    }
    /**
     * Whether a bound session can no longer take work, and therefore has to be replaced.
     *
     * Three outcomes, and each one is deliberate:
     *
     *  - The gateway has no probe → `undefined`, and the binding is reused. This is the behaviour the
     *    channel had before the probe existed, and a composition that cannot answer must not be
     *    punished for it.
     *  - The probe throws → `undefined` plus a diagnostic line. A broken probe is not evidence that
     *    the session is dead, and rebinding on it would throw away a working conversation; treating it
     *    as usable keeps the message on its way.
     *  - `missing` on a binding younger than {@link MISSING_BINDING_GRACE_MS} → `undefined` plus a
     *    diagnostic line. The session's first turn is what writes its record, so a fresh binding is
     *    *expected* to look missing; believing it is what produced an endless run of new sessions on a
     *    live machine.
     *
     * @param binding - The binding about to be reused.
     * @returns `archived` or `missing` when it must be replaced, `undefined` when it may be reused.
     */
    async #deadState(binding) {
        const probe = this.#gateway.sessionState;
        if (probe === undefined)
            return undefined;
        let state;
        try {
            state = await probe.call(this.#gateway, binding.sessionId);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.#diagnose(`session-state: probe failed conversation=${binding.conversationId} ` +
                `session=${binding.sessionId} error=${JSON.stringify(reason)} — treated as usable`);
            return undefined;
        }
        if (state === 'usable')
            return undefined;
        if (state === 'missing') {
            const ageMs = Date.now() - binding.createdAt;
            if (ageMs < MISSING_BINDING_GRACE_MS) {
                this.#diagnose(`session-state: ${binding.sessionId} reported missing but its binding is only ` +
                    `${String(Math.round(ageMs / 1000))}s old (grace ${String(MISSING_BINDING_GRACE_MS / 1000)}s) ` +
                    `— reusing it, its first turn has probably not written a record yet`);
                return undefined;
            }
        }
        return state;
    }
    /**
     * Report one routing decision to the host's log, when a sink was given.
     *
     * @param line - The line to write.
     */
    #diagnose(line) {
        this.#onDiagnostic?.(line);
    }
    /**
     * The conversations belonging to the channel's own workspace.
     *
     * @param fallback - The full list, used when the composition cannot tell the two apart. Without a
     *   workspace-aware gateway everything counts as this workspace's own, which is the old behaviour
     *   and the best available answer.
     * @returns This workspace's rows.
     */
    async #ownSessions(fallback) {
        return (await this.#gateway.listOwnSessions?.()) ?? fallback;
    }
    /** The workspaces this machine has conversations in, in the order the first level prints them. */
    #folders(rows) {
        return sessionFolders(rows, {
            ...(this.#ownWorkspace === undefined ? {} : { ownWorkspace: this.#ownWorkspace }),
            ownLabel: this.#ownWorkspaceLabel,
            labels: this.#labels,
        });
    }
    /** Whether a folder is the channel's own workspace. */
    #isOwnFolder(path) {
        if (path === '')
            return true;
        return this.#ownWorkspace !== undefined && isSameWorkspace(path, this.#ownWorkspace);
    }
    /**
     * The conversations inside one folder, newest first.
     *
     * The own workspace is asked for by name rather than filtered out of the whole-machine list, so a
     * gateway that reports the two separately cannot have its own rows go missing here.
     *
     * Sorted here rather than trusted from the gateway, for the same reason `/switch` sorts its own
     * pool: the number a reply uses is a position in *this* order, and a gateway that handed its rows
     * over in directory order would make the same number mean two different things depending on which
     * listing it came from.
     *
     * @param path - Folder directory, `''` for the channel's own.
     * @param all - Every conversation the machine knows.
     * @param own - The channel's own conversations.
     * @returns Its rows, newest first.
     */
    #rowsIn(path, all, own) {
        const rows = this.#isOwnFolder(path)
            ? own
            : all.filter((session) => session.workspace !== undefined && isSameWorkspace(session.workspace, path));
        return orderRowsWithBranches([...rows].sort(compareSessionsNewestFirst));
    }
    /** The name a folder is printed and recognised by. */
    #folderLabel(path) {
        if (this.#isOwnFolder(path))
            return this.#ownWorkspaceLabel;
        return this.#labels.get(path) ?? (workspaceLabel(path) || path);
    }
    /**
     * Open one folder's conversations as a reply.
     *
     * Shared by the two ways in — picking a folder from the workspace listing, and `/工作区 名称` — so the
     * numbering and the browse position are identical either way. A number typed afterwards resolves
     * against the rows on screen, and that only holds if both entries built the same screen.
     *
     * @param params - Routing parameters, for the held-conversations wording.
     * @param folder - The folder being opened.
     * @param all - Every conversation the machine knows.
     * @param own - The channel's own conversations.
     * @param currentId - Session this conversation is bound to, for the row marker.
     * @param heldHint - Caller's wording for the "there are more elsewhere" sentence.
     * @param page - 1-based page to render.
     * @param at - Timestamp stored with the browse position.
     * @returns A reply carrying the screen and the new browse position.
     */
    #folderSessionsReply(params, folder, all, own, currentId, heldHint, page, at) {
        const rows = this.#rowsIn(folder.path, all, own);
        const pages = Math.max(1, Math.ceil(rows.length / BROWSE_PAGE_SIZE));
        const start = Math.max(1, Math.min(page, pages));
        const end = Math.min(pages, start + MAX_LIST_CARDS - 1);
        const options = {
            label: folder.label,
            total: rows.length,
            ...(currentId === undefined ? {} : { currentId }),
            ...(this.#isOwnFolder(folder.path) ? this.#heldHintFor(own, all, heldHint) : {}),
        };
        const screens = [];
        for (let current = start; current <= end; current += 1) {
            const rendered = renderSessionScreen(rows, { ...options, page: current });
            screens.push({ screen: rendered.screen, numbered: rendered.numbered });
        }
        const first = renderSessionScreen(rows, { ...options, page: start });
        return {
            kind: 'reply',
            text: end < pages ? `${first.text}\n\n共 ${pages} 页，回复「/其余」继续。` : first.text,
            numbered: first.numbered,
            screen: screens[0].screen,
            screens,
            browse: { level: 'sessions', workspace: folder.path, page: end, at },
        };
    }
    /** `/其余`: the next batch of cards of the listing the conversation is standing in. */
    async #moreReply(params) {
        const position = params.browse;
        if (position === undefined) {
            return { kind: 'reply', text: '现在没有可以继续浏览的列表。回复「/会话列表」或「/工作区列表」重新开始。' };
        }
        const all = await this.#gateway.listSessions();
        const own = await this.#ownSessions(all);
        const at = Date.now();
        if (position.level === 'folders') {
            const folders = this.#folders(all);
            const pages = Math.max(1, Math.ceil(folders.length / BROWSE_PAGE_SIZE));
            const start = Math.max(1, position.page) + 1;
            if (start > pages)
                return { kind: 'reply', text: `只有 ${pages} 页，已经到底了。`, browse: position };
            const end = Math.min(pages, start + MAX_LIST_CARDS - 1);
            const screens = [];
            for (let page = start; page <= end; page += 1)
                screens.push(folderScreen(folders, page));
            return {
                kind: 'reply',
                text: renderFolderScreen(folders, start) + (end < pages ? `\n\n共 ${pages} 页，回复「/其余」继续。` : ''),
                screen: screens[0],
                screens,
                browse: { ...position, page: end, at },
            };
        }
        if (position.level === 'sessions') {
            const rows = this.#rowsIn(position.workspace, all, own);
            const pages = Math.max(1, Math.ceil(rows.length / BROWSE_PAGE_SIZE));
            const start = Math.max(1, position.page) + 1;
            if (start > pages)
                return { kind: 'reply', text: `只有 ${pages} 页，已经到底了。`, browse: position };
            const end = Math.min(pages, start + MAX_LIST_CARDS - 1);
            const bindings = await this.#load();
            const currentId = bindings[params.conversationId]?.sessionId;
            const label = this.#folderLabel(position.workspace);
            const options = { label, total: rows.length, ...(currentId === undefined ? {} : { currentId }) };
            const screens = [];
            for (let page = start; page <= end; page += 1) {
                const rendered = renderSessionScreen(rows, { ...options, page });
                screens.push({ screen: rendered.screen, numbered: rendered.numbered });
            }
            const first = renderSessionScreen(rows, { ...options, page: start });
            return {
                kind: 'reply',
                text: end < pages ? `${first.text}\n\n共 ${pages} 页，回复「/其余」继续。` : first.text,
                numbered: first.numbered,
                screen: screens[0].screen,
                screens,
                browse: { ...position, page: end, at },
            };
        }
        return { kind: 'reply', text: '现在没有可以继续浏览的列表。', browse: position };
    }
    /**
     * The sentence a folder screen adds about the conversations it cannot show.
     *
     * Only the channel's own folder gets one: the user asked for this workspace's conversations and
     * the rest are somewhere they did not ask about, so they are counted and named rather than left
     * invisible. Inside another folder the same sentence would be noise — that is the folder they
     * chose, and its contents are what they are looking at.
     *
     * @param own - The channel's own conversations.
     * @param all - Every conversation the machine knows.
     * @param hint - Caller's wording for reaching the rest, which differs between typed and spoken.
     */
    #heldHintFor(own, all, hint) {
        const ownIds = new Set(own.map((session) => session.sessionId));
        const held = all.filter((session) => !ownIds.has(session.sessionId));
        if (held.length === 0)
            return {};
        return {
            held: { count: held.length, names: heldNames(held) },
            ...(hint === undefined ? {} : { heldHint: hint }),
        };
    }
    /**
     * Answer a message from a conversation that is part-way through a listing.
     *
     * 「查看其余」 has no target, so it can only be understood against where the user is standing —
     * which is the whole reason the position is persisted. A number or a name is read as a step in the
     * level they are on: a workspace at the first, a conversation at the second.
     *
     * Returns nothing when the message is not a step. That is deliberate and load-bearing: a remark
     * typed while a listing is on screen — a question, an instruction, an answer to something the
     * agent asked — has to reach the agent, so the browser only claims what it can actually resolve.
     *
     * @param params - The routing parameters, for the numbering and the caller's held wording.
     * @param text - The message, already trimmed.
     * @param position - Where the conversation is in the browser.
     * @returns A reply with the new position, or undefined when this is not a step.
     */
    async #browseReply(params, text, position) {
        const bindings = await this.#load();
        const all = await this.#gateway.listSessions();
        const own = await this.#ownSessions(all);
        const currentId = bindings[params.conversationId]?.sessionId;
        const now = Date.now();
        if (position.level === 'folders') {
            const folders = this.#folders(all);
            if (isShowRest(text)) {
                const { pages } = browsePage(folders, position.page);
                if (position.page >= pages) {
                    return {
                        kind: 'reply',
                        text: `会话夹只有 ${String(pages)} 页，已经到底了。\n回复编号或名字进入。`,
                        // Kept, not cleared: nothing changed, and the user is plainly still reading.
                        browse: position,
                    };
                }
                return {
                    kind: 'reply',
                    text: renderFolderScreen(folders, position.page + 1),
                    screen: folderScreen(folders, position.page + 1),
                    browse: { ...position, page: position.page + 1, at: now },
                };
            }
            const resolution = resolveFolder(text, folders);
            if (resolution.kind === 'ambiguous') {
                return {
                    kind: 'reply',
                    text: ambiguousFolderMessage(text, resolution.candidates, folders),
                    browse: position,
                };
            }
            if (resolution.kind === 'unprinted') {
                // Answered rather than handed to the agent, and the position is kept: a number that named no
                // workspace is still a step inside the folder list, not a message to anyone.
                return {
                    kind: 'reply',
                    text: unprintedFolderMessage(resolution.number, resolution.count),
                    browse: position,
                };
            }
            if (resolution.kind === 'none')
                return undefined;
            const folder = resolution.folder;
            return this.#folderSessionsReply(params, folder, all, own, currentId, params.heldHint, 1, now);
        }
        const rows = this.#rowsIn(position.workspace, all, own);
        if (isShowRest(text)) {
            const { pages } = browsePage(rows, position.page);
            if (position.page >= pages) {
                return {
                    kind: 'reply',
                    text: `【${this.#folderLabel(position.workspace)}】只有 ${String(pages)} 页，已经到底了。\n回复编号或行尾 6 位 id 切换。`,
                    browse: position,
                };
            }
            const currentId = bindings[params.conversationId]?.sessionId;
            const screen = renderSessionScreen(rows, {
                label: this.#folderLabel(position.workspace),
                page: position.page + 1,
                total: rows.length,
                ...(currentId === undefined ? {} : { currentId }),
                ...(this.#isOwnFolder(position.workspace)
                    ? this.#heldHintFor(own, all, params.heldHint)
                    : {}),
            });
            return {
                kind: 'reply',
                text: screen.text,
                numbered: screen.numbered,
                screen: screen.screen,
                browse: { ...position, page: position.page + 1, at: now },
            };
        }
        /*
         * Anything else is read the way `/switch` reads a target, so a number, a trailing id and a name
         * all work and both routes resolve identically.
         *
         * The screen is passed as the last resort for a number, so a reply still works if the listing it
         * answers was never frozen — a state write that failed, say. The numbering the caller supplies
         * wins when it has one, because that is the numbering the user is actually looking at.
         */
        return await this.#switchTo(params, text, {
            mode: 'reply',
            fallback: screenRows(rows, position.page),
            // The walk continues if this turn answers "that number is not on this screen": the user is
            // still reading it, so 「查看其余」 has to go on from here.
            browse: position,
        });
    }
    /**
     * Move this conversation to the session an argument names.
     *
     * Shared by `/switch` and by a reply inside a folder: one resolver, so a number cannot mean one
     * thing to the typed command and another to a reply.
     *
     * @param params - The routing parameters.
     * @param args - What the user typed or replied with.
     * @param options.mode - `command` answers every failure with guidance; `reply` returns nothing for
     *   `none` and `ambiguous`, so a message that merely failed to name a conversation still reaches the
     *   agent. A number that named no row is answered in both modes — see the branch below.
     * @param options.fallback - Numbering to read a number against when the caller has no frozen one.
     * @param options.browse - Where the reply leaves the conversation in the browser, for the one
     *   failure that does not end the walk: a number the screen never printed. Kept because the user is
     *   still reading that screen, so the next 「查看其余」 has to continue it rather than start over.
     * @returns The confirmation, or undefined when nothing resolved and the caller asked to stay quiet.
     */
    async #switchTo(params, args, options) {
        /*
         * A number is read against the listing the user was shown, never re-derived from live sessions.
         *
         * That is the whole point of the numbering: sessions run while the user reads the list, so a
         * number resolved against "whatever is newest now" can land somewhere else entirely. The caller
         * passes the rows a quote pinned, or the newest listing this conversation received; only when it
         * knows of neither does this fall back to the live list.
         */
        const bindings = await this.#load();
        const all = await this.#gateway.listSessions();
        const own = await this.#ownSessions(all);
        const pinned = params.numbered !== undefined && params.numbered.sessions.length > 0
            ? params.numbered
            : options.fallback;
        /*
         * Ordered here rather than trusted from the gateway: the number the user typed refers to a
         * position in a listing, and a listing is ordered by this file. A gateway that happens to hand its
         * rows over in directory order would otherwise make the same number mean two different things
         * depending on whether a list was shown first.
         */
        const pool = pinned !== undefined && pinned.sessions.length > 0
            ? pinned
            : { sessions: [...own].sort(compareSessionsNewestFirst), first: 1 };
        // Ids and titles stay searchable across everything the machine knows, so a session named rather
        // than numbered is still reachable — including one that only a pinned listing knows.
        const known = new Map(all.map((session) => [session.sessionId, session]));
        for (const session of pool.sessions) {
            if (!known.has(session.sessionId))
                known.set(session.sessionId, session);
        }
        const searchable = [...known.values()];
        const resolution = resolveTarget(args, searchable, pool);
        if (resolution.kind === 'unprinted') {
            /*
             * Answered in both modes, unlike `none`: a number is a step in a listing, so handing it to the
             * agent would turn "I picked a row you never printed" into a prompt whose text is "14". The
             * screen's own range is what makes the answer actionable, and the caller's position rides along
             * so the user can carry on reading.
             */
            return {
                kind: 'reply',
                text: unprintedTargetMessage(resolution.number, resolution.first, resolution.last),
                ...(options.browse === undefined ? {} : { browse: options.browse }),
            };
        }
        if (resolution.kind === 'ambiguous') {
            if (options.mode === 'reply')
                return undefined;
            return { kind: 'reply', text: ambiguousTargetMessage(args.trim(), resolution.candidates) };
        }
        if (resolution.kind === 'none') {
            if (options.mode === 'reply')
                return undefined;
            return { kind: 'reply', text: UNKNOWN_TARGET };
        }
        const target = resolution.session;
        await this.#gateway.ensureSession(target.sessionId, target.title);
        const binding = {
            conversationId: params.conversationId,
            accountId: params.accountId,
            peerId: params.peerId,
            sessionId: target.sessionId,
            title: target.title || this.#titlePrefix,
            createdAt: bindings[params.conversationId]?.createdAt ?? Date.now(),
            lastUsedAt: Date.now(),
        };
        bindings[params.conversationId] = binding;
        await this.#store.save(bindings);
        // No `browse`: the reply names a conversation that is now in use, so the listing it came from is
        // finished with and the next 「查看其余」 must not continue it.
        return await this.#switchCard(binding, '已切换到会话「' + binding.title + '」。');
    }
}
/** Commands that may be written with or without an argument. */
const COMMANDS_WITH_ARG = ['/new', '/switch', '/send', '/model', '/permission', '/mode', '/history'];
/** Commands that never take an argument. */
const COMMANDS_BARE = ['/help', '/workspaces', '/workspace', '/sessions', '/list', '/current', '/cancel', '/continue'];
/**
 * Chinese command names, mapped onto the verb the switch below knows.
 *
 * Typed on a phone, so the name that comes naturally is the Chinese one. The English verbs stay the
 * internal vocabulary: the agent's natural-language tools still build `/list`-style lines, and every
 * old name remains a hidden alias, so nothing that worked before stops working. `工作区列表` is a
 * command of its own rather than `/swith all`, because the card it opens is the first screen of the
 * browser, and `工作区` alone was the name that screen already had.
 */
const COMMAND_ALIASES = new Map([
    ['帮助', '/help'],
    ['模型', '/model'],
    ['工作区列表', '/workspaces'],
    ['工作区', '/workspaces'],
    ['会话列表', '/sessions'],
    ['会话', '/sessions'],
    ['列表', '/sessions'],
    ['切换', '/switch'],
    ['发送', '/send'],
    ['新会话', '/new'],
    ['新建', '/new'],
    ['停止', '/cancel'],
    ['停下', '/cancel'],
    ['权限', '/permission'],
    ['模式', '/mode'],
    ['聊天记录', '/history'],
    ['当前', '/current'],
    ['等待', '/wait'],
    ['完成', '/done'],
    ['其余', '/more'],
    ['继续看', '/more'],
    ['继续', '/continue'],
]);
/**
 * The command reference, in one place for both `/帮助` and the command card.
 *
 * Kept as data rather than prose so the card and the text cannot drift apart: the card is what the
 * user sees on the phone, and the text is the fallback when a card cannot be sent.
 */
export const COMMAND_HELP = [
    { command: '/帮助', description: '全部指令的卡片' },
    { command: '/工作区列表', description: '全部工作区（卡片）' },
    { command: '/会话列表', description: '当前工作区的会话（卡片）' },
    { command: '/模型', description: '模型与思考等级（卡片）' },
    { command: '/模型/编号-等级', description: '切换当前会话的模型与等级' },
    { command: '/切换', description: '全部工作区（卡片）' },
    { command: '/切换/工作区', description: '浏览该工作区的会话，不换当前会话' },
    { command: '/切换/会话', description: '切换当前会话' },
    { command: '/切换/工作区-会话', description: '直接切到该会话' },
    { command: '/发送', description: '全部工作区与会话清单（md）' },
    { command: '/发送/工作区-会话', description: '下一条消息发给该会话，不切换当前会话' },
    { command: '/新会话', description: '新建会话并显示它的模型与模式' },
    { command: '/权限', description: '当前会话的权限（卡片）' },
    { command: '/权限/名称', description: '修改权限：查看/修改/完全/审查' },
    { command: '/模式', description: '当前会话的模式（卡片）' },
    { command: '/模式/名称', description: '修改模式（仅未聊天的会话）' },
    { command: '/聊天记录', description: '会话统计（卡片）' },
    { command: '/聊天记录/条数', description: '导出最近 N 条聊天记录（md）' },
    { command: '/停止', description: '停止当前任务' },
    { command: '/当前', description: '当前会话卡片：模型/权限/模式' },
    { command: '/等待', description: '开始暂存消息，发 /完成 才交给模型' },
    { command: '/完成', description: '把暂存的消息一起交给模型' },
    { command: '/其余', description: '继续看下一批列表' },
    { command: '/继续', description: '刷新回复窗口，不发给模型' },
];

/**
 * Rewrite a typed command into the English verb `splitCommand` understands.
 *
 * Only the command word is touched: the argument keeps whatever the user typed, including Chinese
 * punctuation. A command that is not an alias is returned unchanged, which is what keeps the legacy
 * `/list`, `/switch`, `/model` paths working.
 *
 * @param text - The message, already known to start with `/`.
 * @returns The same message with its command word normalised.
 */
/**
 * The alias table in effect for a message: the built-in Chinese names plus the user's own renames.
 *
 * A custom target is accepted as either a slash command (`/list`) or one of the built-in Chinese names
 * (`会话`), because the settings page shows the name the user already knows; both end up as the slash
 * command the switch understands.
 *
 * @param customAliases - `自定义名 -> 目标命令` from settings, when the user configured any.
 * @returns The merged alias table.
 */
function resolveAliases(customAliases) {
    if (customAliases === undefined || customAliases === null || typeof customAliases !== 'object') {
        return COMMAND_ALIASES;
    }
    const merged = new Map(COMMAND_ALIASES);
    for (const [key, value] of Object.entries(customAliases)) {
        const name = String(key).trim();
        const target = String(value ?? '').trim();
        if (name === '' || target === '') {
            continue;
        }
        if (name.startsWith('/')) {
            /*
             * New shape: `canonical command -> alias word`, e.g. `/帮助` -> `协助`.
             *
             * The built-in words for that command are dropped first so a rename replaces the name
             * instead of adding a second one: otherwise `/帮助` would answer both to `帮助` and the
             * new word, and the settings page would show a rename that did not actually rename.
             */
            for (const [word, canonical] of [...merged]) {
                if (canonical === name)
                    merged.delete(word);
            }
            merged.set(target.toLowerCase(), name);
        }
        else {
            /*
             * Legacy shape from earlier versions: `alias word -> target command or built-in name`.
             * Kept so a state file written by a previous install still routes after the upgrade.
             */
            const canonical = target.startsWith('/') ? target : COMMAND_ALIASES.get(target.toLowerCase()) ?? `/${target}`;
            merged.set(name.toLowerCase(), canonical);
        }
    }
    return merged;
}
export function normalizeCommandText(text, customAliases) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed.startsWith('/'))
        return trimmed;
    const aliases = resolveAliases(customAliases);
    const lower = trimmed.toLowerCase();
    const sep = lower.search(/[\s:：/]/);
    const head = (sep >= 0 ? lower.slice(0, sep) : lower).slice(1);
    const args = sep >= 0 ? trimmed.slice(sep + 1).replace(/^[\s:：\/]+/, '').trim() : '';
    const aliased = aliases.get(head);
    if (aliased !== undefined) {
        if (args === '')
            return aliased;
        return `${aliased} ${args.replace(/^\/+/, '').trim()}`;
    }
    /*
     * A glued Chinese argument: `/工作区列表` is one command, `/切换工作区-会话` is a command and an
     * argument. Longest prefix wins so `/工作区列表` is not read as `/工作区` plus a name. An ASCII
     * letter right after the command name means this was a different word (`/news`), not this command
     * with a glued argument — the same rule `splitCommand` applies to the English names.
     */
    let best;
    for (const [name, command] of aliases) {
        if (!lower.startsWith(`/${name}`))
            continue;
        if (best === undefined || name.length > best.name.length) {
            best = { name, command, rest: trimmed.slice(name.length + 1) };
        }
    }
    if (best !== undefined) {
        const rest = best.rest.replace(/^[\s:：\/]+/, '').trim();
        if (/^[a-z]/i.test(rest))
            return trimmed;
        return rest === '' ? best.command : `${best.command} ${rest}`;
    }
    /*
     * The full-width colon is what a Chinese keyboard produces, and `splitCommand` only knows the
     * ASCII one — so the one case that still needs a rewrite here is a legacy command typed with it.
     */
    return trimmed.replace(/^(\/[^\s:：]+)[：]/, '$1 ');
}
/** The command card's screen payload, handed to the host so it renders the same rows as `helpText`. */
export function commandScreen() {
    return {
        level: 'commands',
        title: '全部指令',
        subtitle: '回复「/帮助」随时呼出',
        rows: COMMAND_HELP.map((entry) => ({ command: entry.command, description: entry.description })),
        footer: '指令别名可在设置页「指令」里逐条修改',
    };
}
/** What to call the selection a model listing reports current, with its level when it has one. */
function modelInUseLabel(listing, models) {
    const current = listing.current;
    if (current === undefined)
        return undefined;
    const name = labelOfModel(current, models);
    const found = models.find((option) => option.provider === current.provider && option.model === current.model);
    const level = levelName(current.reasoningEffort, found?.levels ?? []);
    return level === undefined ? name : `${name} · ${level}`;
}
/** Whether a selection points at exactly this model. */
function sameModel(current, model) {
    return current !== undefined && current.provider === model.provider && current.model === model.model;
}
/**
 * Split `/模型 编号-等级` into a model and a level.
 *
 * The dash is only a separator when the left half names a model: model ids contain dashes themselves
 * (`deepseek-v4`), so a split that always fired would break the common case.
 */
function splitModelLevel(value, models) {
    const text = value.trim();
    const dash = text.lastIndexOf('-');
    if (dash > 0) {
        const target = text.slice(0, dash).trim();
        const level = text.slice(dash + 1).trim();
        if (target !== '' && level !== '' && resolveModelOption(target, models) !== undefined)
            return { target, level };
    }
    return { target: text };
}
/** The permission card as a sentence, for the fallback path when no card can be sent. */
function permissionText(info, title) {
    return [
        `会话「${title}」的权限现在是${info.current.label}。`,
        `可改为：${info.available.map((preset) => preset.label).join('、')}。`,
        '回复「/权限 名称」修改。',
    ].join('\n');
}
/** The mode card as a sentence, for the fallback path when no card can be sent. */
function modeText(info, title) {
    return [
        `会话「${title}」的模式现在是${info.current.name}。`,
        `可选：${info.available.map((preset) => preset.name).join('、')}。`,
        '回复「/模式 名称」修改；模式只能在还没开始聊天的会话里换。',
    ].join('\n');
}
/** The statistics card as a sentence, for the fallback path when no card can be sent. */
function historyText(stats, title) {
    const percent = stats.contextPercent === undefined ? '—' : `${Math.round(stats.contextPercent)}%`;
    return [
        `会话「${title}」共 ${String(stats.turns ?? 0)} 条聊天。`,
        `上下文比例：${percent}`,
        `计费 token：${stats.tokens === undefined ? '—' : String(stats.tokens)}`,
        `第一次聊天：${stampText(stats.firstAt) || '—'}`,
        `最后一次：${stampText(stats.lastAt) || '—'}`,
        '回复「/聊天记录 50」导出最近 50 条。',
    ].join('\n');
}
/** `YYYYMMDD-HHmmss` in local time, for exported file names. */
function fileNameStamp(at) {
    const date = new Date(at);
    const pad = (value) => String(value).padStart(2, '0');
    return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
        `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
/** `YYYY-MM-DD HH:mm` in local time, or an empty string. */
function stampText(at) {
    if (at === undefined || !Number.isFinite(at))
        return '';
    const date = new Date(at);
    const pad = (value) => String(value).padStart(2, '0');
    return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Split `/cmd args` into its parts.
 *
 * The separator space is optional, and `:` is accepted in its place, because these
 * commands are typed on a phone keyboard where a dropped space is the common case.
 * `/switch1`, `/switch 1`, and `/switch:1` all mean the same thing. A leading token
 * that only *starts* with a command name is left alone, so `/news` is not `/new`.
 */
export function splitCommand(text) {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    const space = trimmed.search(/\s/);
    if (space >= 0) {
        return { command: lower.slice(0, space), args: trimmed.slice(space + 1).trim() };
    }
    const colon = lower.indexOf(':');
    if (colon > 0) {
        return { command: lower.slice(0, colon), args: trimmed.slice(colon + 1).trim() };
    }
    if (COMMANDS_BARE.includes(lower)) {
        return { command: lower, args: '' };
    }
    for (const command of COMMANDS_WITH_ARG) {
        if (!lower.startsWith(command))
            continue;
        const rest = trimmed.slice(command.length);
        // A following ASCII letter means this was a different word, not this command
        // with a glued argument: `/news` must not parse as `/new` plus `s`. Digits and
        // non-ASCII text are legitimate glued arguments (`/switch1`, `/new我的任务`).
        if (/^[a-z]/.test(rest))
            continue;
        return { command, args: rest.replace(/^[:\s]+/, '').trim() };
    }
    return { command: lower, args: '' };
}
/** What a `/switch` and a reply inside a folder both say when nothing matched. */
const UNKNOWN_TARGET = '找不到这个对话。回复 /list 看清单，再回复数字或 id。';
/**
 * What the user is told when their conversation had to be moved to a new session.
 *
 * Said out loud because the alternative is a conversation that silently changed identity: the
 * messages keep going out, the answers come back from a session with no history, and the only
 * explanation available is a log line the user cannot see. The old title is named so they recognise
 * which conversation was left behind, and the new one so they can find it in `/list`.
 *
 * @param previousTitle - Title of the session that can no longer take messages.
 * @param state - Why it was replaced.
 * @param nextTitle - Title of the session that is now bound.
 * @returns The sentence to send into the chat.
 */
function replacedBindingNotice(previousTitle, state, nextTitle) {
    const why = state === 'archived' ? '已经被归档' : '在电脑上已经不存在了';
    return (`原对话「${previousTitle}」${why}，我已新建「${nextTitle}」并接到这里。\n` +
        '你刚发的这条会发到新对话里，之前那个的上下文不在新对话里。');
}
/**
 * Resolve a `/switch` argument against the session list.
 *
 * Accepts a 1-based list position, a full session id, the short id printed by `/list` (or any longer
 * prefix of it), or a title — a phone keyboard makes copying a full uuid painful.
 *
 * Matching is deliberately strict. Session ids share a common shape (`session-<short>-<uuid>`), so a
 * loose `includes` test can match several rows; an ambiguous argument must fail rather than switch to
 * a surprise session. Since the printed id is only the first few hex digits of it, two conversations
 * *can* share one, and the caller is told to ask for a longer one rather than being handed whichever
 * happened to be found first.
 *
 * Order matters: the exact readings are tried before the prefix reading, so a conversation whose
 * title looks like a hex fragment is still reachable by that title.
 *
 * **A number is a row of the listing, never a fragment of an identifier.** It used to fall through to
 * the id and title readings when no row carried it, and that fall-through is what produced three
 * flaky tests and blocked a release: `99` and `14` are legal hex prefixes, so a session whose
 * six-character id happened to begin with either made `/switch` *succeed* where the caller required
 * it to fail. The auto-generated title repeats those same six characters (`微信 14c71a`), so the
 * loose title reading could have rescued the number even if the prefix reading had been removed —
 * which is why patching one reading at a time never held. A number that names no row is answered with
 * `unprinted` (the row range it could have named) instead of being reinterpreted: ambiguity has to
 * fail out loud, because a guess moves the user's conversation somewhere they never asked to be.
 * Refusing costs nothing a number could still deliver, because every conversation is a row of some
 * listing.
 *
 * The one thing a number may still name is the **exact** short id the row prints, six characters and
 * no more — otherwise a row whose id happens to be all digits (`123456`, about one in seventeen)
 * could not be typed as the id the listing tells the user to type. That is an exact identifier, not a
 * prefix match, and it is tried only when no row carries the number.
 *
 * @param args - What the user typed after `/switch`.
 * @param sessions - Every session that may be named, usually the whole machine.
 * @param numbered - The rows a number refers to, and the number printed beside the first of them.
 *
 *   This matters because the two are not the same list. A number is answered from the listing the
 *   user was actually shown, while a title or id may name a session from any workspace — and a
 *   conversation the user picked out of a listing has to be switchable, or the listing is a lie.
 *   The offset is part of it because numbering runs on across screens: the second screen of ten
 *   prints 11..20, and a "13" read as row 3 would move the chat to a conversation that screen never
 *   showed.
 */
export function resolveTarget(args, sessions, numbered = { sessions: [...sessions], first: 1 }) {
    const value = args.trim();
    if (!value)
        return { kind: 'none' };
    if (/^\d+$/.test(value)) {
        // A number refers to a row of the listing the user was shown, which is not necessarily the whole
        // machine — hence `numbered` rather than `sessions`.
        const index = Number(value) - numbered.first;
        const byIndex = index < 0 ? undefined : numbered.sessions[index];
        if (byIndex !== undefined)
            return { kind: 'found', session: byIndex };
        /*
         * Nothing on this screen carries that number. The listing prints one other form, though, and a
         * number is a legal hex string: a row whose short id is six digits (`123456`) would otherwise
         * stop working when typed exactly as printed — about one row in seventeen, and that row may not
         * be on the screen the user has in hand.
         *
         * So the *exact* printed short id is still read, and it is the only thing that is: not a prefix
         * of one (`14` must never find `14c71a`, which is the third incident), not a longer numeric
         * prefix, not a title. That is an exact identifier the row itself prints, not a guess between
         * candidates; several sessions can share one, and then the answer is the same "your id is too
         * short" it is for any other collision.
         */
        if (value.length === SHORT_ID_LENGTH) {
            const exactShort = sessions.filter((session) => shortId(session.sessionId).toLowerCase() === value.toLowerCase());
            if (exactShort.length === 1)
                return { kind: 'found', session: exactShort[0] };
            if (exactShort.length > 1)
                return { kind: 'ambiguous', candidates: exactShort };
        }
        /*
         * Anything else is refused, deliberately *not* a fall-through to the id and title readings, which
         * is the bug this function was rebuilt around: a number that names no row is ambiguous between a
         * row of a screen the user is not looking at and some identifier, and reinterpreting it moves
         * their conversation somewhere they never asked to be. A number *below* the screen's first one is
         * refused for the same reason — numbering runs on, so it belongs to a screen the user has
         * scrolled past, and folding it onto row 1 is the drift the pin exists to prevent.
         */
        return numbered.sessions.length === 0
            ? { kind: 'none' }
            : {
                kind: 'unprinted',
                number: Number(value),
                first: numbered.first,
                last: numbered.first + numbered.sessions.length - 1,
            };
    }
    const exactId = sessions.find((session) => session.sessionId === value);
    if (exactId !== undefined)
        return { kind: 'found', session: exactId };
    const byTitle = sessions.find((session) => session.title === value);
    if (byTitle !== undefined)
        return { kind: 'found', session: byTitle };
    // The short id lives in the middle: `session-<short>-<uuid>`. Any prefix of it does too, which is
    // what makes "use a longer id" an answer the user can act on. Only non-numeric arguments reach
    // here: a number was answered above, one way or the other.
    if (/^[0-9a-f]+$/i.test(value)) {
        const lower = value.toLowerCase();
        const byPrefix = sessions.filter((session) => idKeyOf(session.sessionId).startsWith(lower));
        if (byPrefix.length === 1)
            return { kind: 'found', session: byPrefix[0] };
        if (byPrefix.length > 1)
            return { kind: 'ambiguous', candidates: byPrefix };
    }
    const bySuffix = sessions.filter((session) => session.sessionId.endsWith(value));
    if (bySuffix.length === 1)
        return { kind: 'found', session: bySuffix[0] };
    if (bySuffix.length > 1)
        return { kind: 'ambiguous', candidates: bySuffix };
    /*
     * Last, a *core* title match in either direction — and only when exactly one session matches.
     *
     * People name a conversation the way they talk about it, in both directions of slop: they type a
     * fragment («北京»), or they add words of their own («北京今天天气如何**会话**»). Both are the same
     * request as the exact title, and exact matching alone failed on each — a hard failure for a
     * request the user can see is answerable.
     *
     * Uniqueness is the safeguard, and it is why this is the last resort. Several matches, or none,
     * return nothing: an ambiguous argument must fail rather than move the conversation somewhere the
     * user did not ask for. A word as short as a single character will usually match nothing here for
     * the same reason — good, because it would be a guess.
     */
    const core = (session) => session.title.includes(value) || value.includes(session.title);
    const byCore = sessions.filter((session) => session.title !== '' && core(session));
    if (byCore.length === 1)
        return { kind: 'found', session: byCore[0] };
    return { kind: 'none' };
}
/**
 * The answer to a number that named no row of the screen the user was shown.
 *
 * The first line is the whole explanation, because the channel quotes only that line back when this
 * answer travels through the tool: a failure announced without the range would leave the user typing
 * numbers at a screen that cannot answer them. It opens with `找不到` for a second, unrelated reason:
 * the host decides whether a spoken switch succeeded by that word, so an answer that named no
 * conversation has to keep saying so. The tail offers the other form the row prints — which does work
 * for any six characters, including an all-digit one, because that is read as the exact id when no
 * row carries the number.
 *
 * @param value - The number the user typed.
 * @param first - Number printed beside the screen's first row.
 * @param last - Number printed beside its last row.
 * @returns The message body.
 */
export function unprintedTargetMessage(value, first, last) {
    const range = `${String(first)}–${String(last)}`;
    const where = value < first
        ? `这一屏是 ${range}（编号跨屏连续）`
        : `这一屏只有 ${String(last - first + 1)} 项（${range}）`;
    return [
        `找不到编号 ${String(value)}：${where}。`,
        '要用 id 请回行尾那 6 位；回复 /list 能再看一次清单。',
    ].join('\n');
}
/**
 * The identifier a short id is a prefix of.
 *
 * The id is `session-<hex>-<uuid>`, and the hex group repeats the first characters of the uuid, so
 * the middle group is what the user sees and types. Ids without that shape fall back to their bare
 * form, so the same prefix rule still applies to a session from another implementation.
 *
 * @param sessionId - Session id.
 * @returns The string a typed short id is a prefix of, lower-cased.
 */
function idKeyOf(sessionId) {
    const match = /^session-([0-9a-f]+)-/i.exec(sessionId);
    return (match?.[1] ?? sessionId.replace(/^session-/, '')).toLowerCase();
}
/**
 * The message for a `/switch` whose id was too short to identify one conversation.
 *
 * The candidates are printed with the *longest* prefix of their hex group, which is exactly the
 * longer id the user should reply with — and with their titles, because a phone user recognises the
 * conversation, not the id.
 *
 * @param value - What the user typed.
 * @param candidates - Every session it matched.
 * @returns The message body.
 */
export function ambiguousTargetMessage(value, candidates) {
    const lines = candidates.map((session) => {
        const match = /^session-([0-9a-f]+)-/i.exec(session.sessionId);
        const longer = (match?.[1] ?? session.sessionId).toLowerCase();
        return `${longer} · ${(session.title || '(无标题)').trim()}`;
    });
    return [
        `有多个会话匹配「${value}」，请用更长的 id（下面每一行开头的就是）：`,
        '',
        ...lines,
        '',
        '完整 id 也可以，回复 /list 能再看一次清单。',
    ].join('\n');
}
/**
 * Mint a session id in DSH's own format.
 *
 * The id is `session-<uuid>` because the host treats that shape as its native
 * session identity. The trailing hex group is random; the leading group is
 * derived from it so that the compact form shown by `/list` is also the form
 * `/switch` accepts. Keeping the two identical is what makes switching possible
 * from a phone keyboard.
 */
export function mintSessionId(random = randomUUID) {
    const uuid = random();
    const tail = uuid.replace(/-/g, '').slice(0, 8);
    return `session-${tail}-${uuid}`;
}
/**
 * How many characters of a session id the list prints.
 *
 * Six hex digits is still short enough to read and retype on a phone, while the space it draws from
 * is 16 777 216 values instead of the 65 536 four digits gave: a machine with a few hundred sessions
 * collided often enough to be noticed, and the extra two characters are free to type. The printed
 * form is a prefix of the id, so a collision is answered by asking for more characters rather than by
 * failing. The bound is the requirement, not a preference: an identifier the user has to copy is not
 * an identifier they will use.
 */
export const SHORT_ID_LENGTH = 6;
/** Compact identifier shown to the user, and accepted back by `/switch`. */
export function shortId(sessionId) {
    const match = /^session-([0-9a-f]+)-/i.exec(sessionId);
    if (match)
        return match[1].slice(0, SHORT_ID_LENGTH);
    return sessionId.replace(/^session-/, '').slice(0, SHORT_ID_LENGTH);
}
/**
 * The name a user knows a workspace by.
 *
 * The store records absolute directories, and a full path in a chat message is noise. The last
 * component is what the desktop sidebar shows, so it is what the user will recognise.
 *
 * @param path - Working directory recorded for a session.
 * @returns Its final path component, or the path itself when there is nothing to trim.
 */
export function workspaceLabel(path) {
    const parts = path.split(/[\\/]+/).filter((part) => part !== '');
    return parts.at(-1) ?? path;
}
/**
 * Resolve a `/model` argument against the catalog.
 *
 * Accepts a 1-based list position, a model id, or a model name — the same three shapes `/switch`
 * accepts for a conversation, for the same reason: the number is what the listing prints, and the
 * name is what a person remembers. A number is only ever a position; see `resolveTarget` for the
 * incidents that rule comes from.
 *
 * Matching is deliberately strict, and every match must be unique. Two providers can expose the same
 * model id (`deepseek-chat` from two accounts), so a loose match would silently pick one of them, and
 * which one silently picked is not something the user could even see. Several matches return
 * undefined: a model the user did not ask for is worse than a question.
 *
 * @param args - What the user typed after `/model`.
 * @param models - Every model the host offers, in the order the listing numbered them.
 */
export function resolveModelOption(args, models) {
    const value = args.trim();
    if (value === '')
        return undefined;
    if (/^\d+$/.test(value)) {
        /*
         * A number is the row the listing printed and nothing else.
         *
         * It used to fall through to the names and ids, which is the same shape of guess that cost three
         * flaky tests on `/switch` (see {@link resolveTarget}); there is no random id here, so it never
         * bit, but the rule the user set does not have an exception for "it happens to be harmless".
         * Nothing becomes unreachable: the list numbers every model, and the caller already answers a
         * missing number with the instruction to look at it again.
         */
        return models[Number(value) - 1];
    }
    // Case-insensitive, unlike session titles: model ids are machine-written identifiers, and a user
    // retyping `deepseek-chat` from a phone should not have to match its capitalisation.
    const lower = value.toLowerCase();
    const byId = models.filter((option) => option.model.toLowerCase() === lower);
    if (byId.length === 1)
        return byId[0];
    const byName = models.filter((option) => option.name.toLowerCase() === lower);
    if (byName.length === 1)
        return byName[0];
    // Last, a *core* name match in either direction — a fragment, or the name with words of its own,
    // which is how people refer to a model in a sentence. Uniqueness is the safeguard; see above.
    const core = (option) => {
        const name = option.name.toLowerCase();
        return name !== '' && (name.includes(lower) || lower.includes(name));
    };
    const byCore = models.filter(core);
    if (byCore.length === 1)
        return byCore[0];
    return undefined;
}
/**
 * Words that mean "what follows is a reasoning level, not a model".
 *
 * `/model 等级 高`, `/model 2 等级 高` and `/model level high` all name the level explicitly instead of
 * leaving the plugin to guess which half of the argument it is. Nothing else is accepted: a level id
 * is a single word the adapter published, so a positional rule would have to guess where a
 * multi-word model name ends — and a guess here picks either the wrong model or the wrong level,
 * both of which the user would only discover from the next answer.
 *
 * `等级` is matched as a *suffix* so the full name of the setting (`推理等级`, `思考等级`) works
 * without a second spelling table. No model is called that.
 *
 * @param args - What the user typed after `/model`.
 * @returns The parts the command needs, with `levelForm` false for the plain model forms.
 */
export function parseModelCommand(args) {
    const trimmed = args.trim();
    if (trimmed === '')
        return { target: '', levelForm: false };
    const tokens = trimmed.split(/\s+/);
    const at = tokens.findIndex(isLevelWord);
    // No keyword: the whole argument is a model, exactly as it was before levels existed.
    if (at < 0)
        return { target: trimmed, levelForm: false };
    const level = tokens.slice(at + 1).join(' ').trim();
    return {
        target: tokens.slice(0, at).join(' '),
        ...(level === '' ? {} : { level }),
        levelForm: true,
    };
}
/** Whether one token is the word that introduces a level. */
function isLevelWord(token) {
    const lower = token.toLowerCase();
    return (lower === 'level' || lower === 'effort' || lower === 'reasoning' || token.endsWith('等级'));
}
/**
 * Resolve a level the user named against the ones a model publishes.
 *
 * Ids and names are both accepted, case-insensitively, because the two are near-identical for the
 * adapters that ship with DSH (`high` / `High`) and a phone keyboard makes the capitalisation the
 * user's problem otherwise. No partial matching: a level guessed wrong silently changes how much the
 * model thinks, which is not a mistake the user can see in the answer.
 *
 * @param value - What the user typed.
 * @param levels - Levels the model publishes.
 */
export function resolveLevel(value, levels) {
    const lower = value.trim().toLowerCase();
    if (lower === '')
        return undefined;
    return (levels.find((level) => level.id.toLowerCase() === lower) ??
        levels.find((level) => level.name.toLowerCase() === lower));
}
/** The label to print for one effort id, or undefined when the model does not publish it. */
function levelName(effort, levels) {
    if (effort === undefined)
        return undefined;
    return resolveLevel(effort, levels)?.name ?? effort;
}
/** The `推理等级：…` line for a selection that landed on a level, or nothing when it did not. */
function levelReport(effort, option) {
    const label = levelName(effort, option.levels ?? []);
    return label === undefined ? [] : [`推理等级：${label}`];
}
/** The host's own words for a refusal, whatever it threw. */
function reasonOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** The sentence every shape of "there is no level to switch" is answered with. */
const NO_LEVELS = '当前模型不支持推理等级';
/** Openings of the failures `/model` answers with, kept together so the wording cannot drift apart. */
const NOT_FOUND_MODEL = '找不到模型';
const NOT_FOUND_LEVEL = '找不到等级';
const FAILED_MODEL = '切换模型失败';
const FAILED_LEVEL = '切换推理等级失败';
/**
 * Render one model's reasoning levels, with the one in effect marked.
 *
 * The level the conversation is *on* is what is marked; for any other model the host's own default
 * is, because that is the level a switch to it would land on. Only one of the two can apply to a
 * given model — the mark means "you would get this if you stopped typing here".
 *
 * @param option - Model whose levels are being shown.
 * @param current - Selection the host reported, which may be for another model.
 * @param levels - Levels the model publishes.
 * @returns The message body.
 */
export function renderLevels(option, current, levels) {
    const onThisModel = current !== undefined && current.provider === option.provider && current.model === option.model;
    const inEffect = onThisModel ? current.reasoningEffort : option.defaultLevel;
    // `（当前）` only when this *is* the conversation's model: on any other one the marked level is the
    // host's default, and calling that "current" would be a claim about a model nobody is using.
    const mark = onThisModel ? '（当前）' : '（默认）';
    const rows = levels
        .map((level) => `${level.name}${level.id === inEffect ? mark : ''}`)
        .join(' · ');
    const example = levels[0]?.id ?? '';
    return [
        `${option.name} 的推理等级：`,
        '',
        rows,
        '',
        `回复 /model 等级 ${example} 切换。`,
    ].join('\n');
}
/**
 * How many rows one screen of the browser shows, at both levels.
 *
 * Ten, because that is what a phone screen holds and what the listing already showed. The point of
 * two levels is not to fit more on one screen but to make every conversation reachable without ever
 * printing more than a readable amount at once — which is what the old fixed cut could not do.
 */
export const BROWSE_PAGE_SIZE = 10;
/** At most this many cards are sent for one listing; `/其余` continues after them. */
const MAX_LIST_CARDS = 5;
/** The phrase that walks one screen further down whichever level the user is on. */
export const SHOW_REST = '查看其余';
/**
 * Whether a message is the phrase that walks to the next screen.
 *
 * Trailing sentence punctuation is stripped because a phone keyboard adds it and the user is writing
 * a sentence, not typing a token. Nothing else is accepted: this phrase has no target, so a near miss
 * that was guessed at would move the user somewhere they did not ask to go.
 *
 * @param text - The inbound message.
 */
export function isShowRest(text) {
    return text.trim().replace(/[。．.!！?？]+$/, '') === SHOW_REST;
}
/**
 * Group rows into the folders the first level lists.
 *
 * The channel's own workspace leads, because those are the conversations this chat created; the rest
 * follow, most recently active first, with the directory as the tie-break so the same machine always
 * produces the same list. A row that does not say where it lives counts as the channel's own, which
 * is the only workspace a conversation can vouch for.
 *
 * Counts, not rows: the first level answers "which project", and its rows have to be small enough
 * that ten of them name ten projects. A folder holding nothing is left out — a row that opens onto
 * an empty list is a dead end dressed as a choice.
 *
 * @param rows - Every conversation the machine knows.
 * @param options.ownWorkspace - Directory the channel's own conversations live in.
 * @param options.ownLabel - Name printed for that directory.
 * @returns Non-empty folders, in display order.
 */
export function sessionFolders(rows, options) {
    let own = 0;
    let ownNewest = 0;
    const byPath = new Map();
    for (const row of rows) {
        const path = row.workspace;
        const isOwn = path === undefined ||
            (options.ownWorkspace !== undefined && isSameWorkspace(path, options.ownWorkspace));
        if (isOwn) {
            own += 1;
            if (row.updatedAt > ownNewest)
                ownNewest = row.updatedAt;
            continue;
        }
        const seen = byPath.get(path);
        if (seen === undefined)
            byPath.set(path, { count: 1, newest: row.updatedAt });
        else {
            seen.count += 1;
            if (row.updatedAt > seen.newest)
                seen.newest = row.updatedAt;
        }
    }
    const others = [...byPath.entries()]
        .map(([path, stats]) => ({ path, ...stats }))
        .sort((a, b) => {
        if (a.newest !== b.newest)
            return b.newest - a.newest;
        if (a.path === b.path)
            return 0;
        return a.path < b.path ? -1 : 1;
    });
    const folders = [];
    if (own > 0)
        folders.push({ path: options.ownWorkspace ?? '', label: options.ownLabel, count: own, newest: ownNewest });
    for (const group of others) {
        folders.push({
            path: group.path,
            label: options.labels?.get?.(group.path) ?? (workspaceLabel(group.path) || group.path),
            count: group.count,
            newest: group.newest,
        });
    }
    return folders;
}
/**
 * Cut one screen of ten out of an ordered sequence.
 *
 * @param rows - The whole sequence, already ordered.
 * @param page - 1-based screen to cut; clamped into range, so a stored page that no longer exists
 *   still renders something rather than an empty message.
 * @returns The rows on that screen, where the screen sits, and how many there are.
 */
export function browsePage(rows, page) {
    const pages = Math.max(1, Math.ceil(rows.length / BROWSE_PAGE_SIZE));
    const wanted = Number.isFinite(page) ? Math.trunc(page) : 1;
    const current = Math.min(Math.max(wanted, 1), pages);
    const start = (current - 1) * BROWSE_PAGE_SIZE;
    return { items: rows.slice(start, start + BROWSE_PAGE_SIZE), page: current, pages, start };
}
/**
 * The numbering one screen of a folder prints, for a caller that has no frozen listing.
 *
 * Only a fallback: the numbering the user is looking at is the one frozen under the message that
 * printed it, and the caller passes that whenever it has one.
 *
 * @param rows - Every row of the folder, ordered.
 * @param page - Screen the reply is answering.
 * @returns That screen's rows and the number printed beside the first of them.
 */
export function screenRows(rows, page) {
    const { items, start } = browsePage(rows, page);
    return {
        sessions: items.map((session) => ({ sessionId: session.sessionId, title: session.title })),
        first: start + 1,
    };
}
/**
 * Render one screen of the workspace list.
 *
 * @param folders - Every folder, in display order.
 * @param page - 1-based screen to print.
 * @returns The message body.
 */
export function renderFolderScreen(folders, page) {
    const { items, page: current, pages, start } = browsePage(folders, page);
    const sections = [`会话夹（${String(current)}/${String(pages)}）`];
    if (items.length === 0)
        sections.push('（还没有其它工作区）');
    items.forEach((folder, index) => {
        sections.push(`${String(start + index + 1)}. ${folder.label}  ${String(folder.count)} 个会话`);
    });
    sections.push('', current < pages ? '回复编号或名字进入；回复「查看其余」看下十个。' : '回复编号或名字进入。');
    return sections.join('\n');
}
/**
 * The structure of one folder screen, for a caller that renders it as a card instead of text.
 *
 * The text and the card are two views of the same screen: the card draws the rows the text would
 * print, so it must be built from the same page cut. Keeping it here — next to the renderer that
 * produced the numbering — makes it impossible for the two to disagree about which rows are on
 * screen, and therefore about what a replied number means.
 *
 * @param folders - Every folder, in display order.
 * @param page - 1-based screen.
 * @returns The browsable screen: its page position and its rows.
 */
export function folderScreen(folders, page) {
    const { items, page: current, pages, start } = browsePage(folders, page);
    return {
        level: 'folders',
        page: current,
        pages,
        start,
        folders: items.map((folder) => ({ label: folder.label, count: folder.count, newest: folder.newest })),
    };
}
/**
 * Render one screen of a folder's conversations.
 *
 * The numbering runs on across screens, so the second screen of ten prints 11..20 — the number is
 * what the user replies with, and starting over at 1 would give one number two meanings within a
 * single browse.
 *
 * @param rows - Every conversation in the folder, ordered.
 * @param options.label - Folder name, printed in the heading.
 * @param options.page - 1-based screen to print.
 * @param options.currentId - Session this conversation is bound to, marked in the list.
 * @param options.held - Conversations in other folders, counted and named rather than left invisible.
 * @param options.heldHint - How to reach them, which differs between typed and spoken requests.
 * @param options.now - Current time, so every row of one message agrees on what "3 分钟前" means.
 * @param options.total - Every conversation the screen lists, for a caller that shows a count.
 * @returns The message body, the numbering it printed, and the screen structure a card can draw.
 */
export function renderSessionScreen(rows, options) {
    const now = options.now ?? Date.now();
    const { items, page, pages, start } = browsePage(rows, options.page);
    const sections = [`【${options.label}】会话（${String(page)}/${String(pages)}）`];
    if (items.length === 0)
        sections.push('（这个会话夹还没有对话）');
    items.forEach((session, index) => {
        sections.push(renderSessionRow(session, start + index, options.currentId, now));
    });
    const held = options.held;
    if (held !== undefined && held.count > 0) {
        const names = held.names ?? [];
        sections.push('', `另有 ${String(held.count)} 个对话在其它会话夹${names.length === 0 ? '' : `（${names.join('、')}）`}，${options.heldHint ?? '发 /工作区列表 看会话夹。'}`);
    }
    /*
     * The phrase is offered only when there is somewhere for it to go. A listing that ends by inviting
     * the user to ask for more, on a screen where there is no more, teaches them the command does
     * nothing.
     *
     * The row's trailing id is named, not just printed: reading the number and replying with it is what
     * users did, and nothing said the id was also a way in — the one form that cannot expire.
     */
    sections.push('', page < pages
        ? '回复编号或行尾 6 位 id 切换；回复「查看其余」看下十个。'
        : '回复编号或行尾 6 位 id 切换。');
    sections.push('引用这条消息再回编号，可以避免编号过期。');
    return {
        text: sections.join('\n'),
        numbered: {
            sessions: items.map((session) => ({ sessionId: session.sessionId, title: session.title })),
            first: start + 1,
        },
        screen: {
            level: 'sessions',
            label: options.label,
            page,
            pages,
            start,
            ...(options.currentId === undefined ? {} : { currentId: options.currentId }),
            total: options.total ?? rows.length,
            items: items.map((session) => ({
                sessionId: session.sessionId,
                title: session.title,
                updatedAt: session.updatedAt,
                branch: session.branch === true,
            })),
        },
    };
}
/**
 * Resolve what the user typed against the workspace list.
 *
 * Accepts the printed number, the printed name, or a fragment of it — the same three shapes
 * `resolveTarget` accepts for a conversation, for the same reason: the number is what the listing
 * prints, and the name is what a person remembers.
 *
 * Two directories routinely share a last component (`…/workplace` under two parents), and the printed
 * name is that last component — so a name matching several folders returns the candidates instead of
 * picking one. Entering the wrong project's folder is worse than a question.
 *
 * A pure number is a position and nothing else, exactly as in {@link resolveTarget}: it used to fall
 * through to the names, which would enter a folder called `3` when the user meant the third row (or
 * the reverse). The two readings are the same ambiguity that cost three flaky tests on the session
 * side of this browser, and a number out of range says how many there are instead of guessing.
 *
 * @param args - What the user replied with.
 * @param folders - Every folder, in the order the listing numbered them.
 * @returns What it named.
 */
export function resolveFolder(args, folders) {
    const value = args.trim();
    if (value === '')
        return { kind: 'none' };
    if (/^\d+$/.test(value)) {
        const byIndex = folders[Number(value) - 1];
        if (byIndex !== undefined)
            return { kind: 'found', folder: byIndex };
        return { kind: 'unprinted', number: Number(value), count: folders.length };
    }
    const byLabel = folders.filter((folder) => folder.label === value);
    if (byLabel.length === 1)
        return { kind: 'found', folder: byLabel[0] };
    if (byLabel.length > 1)
        return { kind: 'ambiguous', candidates: byLabel };
    // Last, a *core* match in either direction, exactly as a conversation title is matched: people
    // name a project the way they talk about it, so a fragment or the name with words of its own has
    // to work. Uniqueness is the safeguard.
    const byCore = folders.filter((folder) => folder.label !== '' && (folder.label.includes(value) || value.includes(folder.label)));
    if (byCore.length === 1)
        return { kind: 'found', folder: byCore[0] };
    if (byCore.length > 1)
        return { kind: 'ambiguous', candidates: byCore };
    return { kind: 'none' };
}
/**
 * The answer to a folder number this machine has no workspace at.
 *
 * Same shape as {@link unprintedTargetMessage}, for the same reason: the user is looking at a list
 * that printed numbers, so the useful reply is how many it printed. Folders are numbered across the
 * whole list rather than one screen at a time (they are a short list), so there is no screen to name.
 *
 * @param value - The number the user replied with.
 * @param count - Workspaces on this machine.
 * @returns The message body.
 */
export function unprintedFolderMessage(value, count) {
    // Unreachable from the browser (it only opens a list that has a folder on it), and answered rather
    // than left to produce "1–0" if a future caller reaches it.
    if (count <= 0)
        return `找不到编号 ${String(value)}：这台机器还没有会话夹。发 /工作区列表 看一眼。`;
    const range = `1–${String(count)}`;
    return [
        `找不到编号 ${String(value)}：会话夹只有 ${String(count)} 个（${range}）。`,
        `回复 ${range} 的编号，或直接回复名字。`,
    ].join('\n');
}
/**
 * The message for a workspace name that named several folders.
 *
 * The candidates are printed with their numbers, because the number is the one form that is never
 * ambiguous, and it is what the user replies with next.
 *
 * @param value - What the user typed.
 * @param candidates - Every folder it matched.
 * @param folders - The whole list, so each candidate can be shown with its own number.
 * @returns The message body.
 */
export function ambiguousFolderMessage(value, candidates, folders) {
    const lines = candidates.map((folder) => {
        const number = folders.findIndex((candidate) => candidate.path === folder.path) + 1;
        return `${String(number)}. ${folder.path}  ${String(folder.count)} 个会话`;
    });
    return [
        `有多个会话夹匹配「${value.trim()}」，请回复编号：`,
        '',
        ...lines,
        '',
        '回复 /工作区列表 能再看一次会话夹清单。',
    ].join('\n');
}
/** How much of a conversation title a row prints before it is cut. */
const TITLE_LIMIT = 24;
/**
 * Render one row of a session list.
 *
 * The title leads because it is what a person recognises, the time follows because the list is
 * ordered by it, and the **short id closes the row** because it is what `/switch` accepts when a
 * number is not enough — and a workspace heading is shared by every row under it, so two
 * conversations in one workspace are otherwise indistinguishable.
 *
 * One row per line rather than two: a listing of ten conversations has to fit in one WeChat message,
 * and a second line per row doubles the height of a phone screen full of them.
 *
 * @param session - Session to render.
 * @param index - 0-based position, rendered as the 1-based number to reply with.
 * @param currentId - Session this conversation is bound to, marked in the list.
 * @param now - Current time, so every row of one message agrees on what "3 分钟前" means.
 * @returns The row.
 */
export function renderSessionRow(session, index, currentId, now = Date.now()) {
    const mark = session.sessionId === currentId ? ' ← 当前' : '';
    // The arrow is the branch marker: a subagent conversation is a branch of the turn above it, and
    // the text listing has to say so for the same reason the card draws a folded arrow.
    const branch = session.branch === true ? '↳ ' : '';
    const title = truncateTitle(session.title ?? '');
    // A record with no usable timestamp is left undated rather than shown as 1970: a session the store
    // knows nothing about is better described by its title than by an epoch it never had.
    const at = session.updatedAt;
    const when = at === undefined || !Number.isFinite(at) || at <= 0 ? '' : ` · ${relativeTime(at, now)}`;
    return `${String(index + 1)}. ${branch}${title}${when}${mark}  ${shortId(session.sessionId)}`;
}
/**
 * Trim a conversation title for one row.
 *
 * A session is named from the user's first sentence, which is routinely a whole paragraph. Printing it
 * whole pushes the time and the id off the screen, and those are the parts the row exists to deliver.
 *
 * @param title - Title as recorded.
 * @returns A title that fits, or `(无标题)`.
 */
function truncateTitle(title) {
    const trimmed = title.trim().replace(/\s+/g, ' ');
    if (trimmed === '')
        return '(无标题)';
    return trimmed.length <= TITLE_LIMIT ? trimmed : `${trimmed.slice(0, TITLE_LIMIT)}…`;
}
/**
 * The message for a `/list` whose own workspace has no conversations yet.
 *
 * @param held - Conversations in other workspaces.
 * @param ownLabel - Heading for the channel's own workspace.
 * @returns The message body.
 */
export function heldOnlyList(held, ownLabel) {
    return [
        `【${ownLabel}】还没有对话，直接发消息就会新建一个。`,
        '',
        `另有 ${String(held.length)} 个对话在其它会话夹${heldHintSuffix(held)}，发 /工作区列表 看会话夹。`,
    ].join('\n');
}
/**
 * The workspace names behind a set of held rows, for the sentence that counts them.
 *
 * @param held - Rows left out of a listing.
 * @returns Distinct workspace labels, sorted, without duplicates.
 */
export function heldNames(held) {
    const names = new Set();
    for (const session of held) {
        if (session.workspace !== undefined)
            names.add(workspaceLabel(session.workspace));
    }
    return [...names].sort();
}
/** `（a、b）` for the held-workspace names, or an empty string when there are none. */
function heldHintSuffix(held) {
    const names = heldNames(held);
    return names.length === 0 ? '' : `（${names.join('、')}）`;
}
/**
 * Render the model list.
 *
 * Unlike sessions this is not capped. A session list grows without bound as a machine is used, so it
 * needs a cut-off; a model catalog is a closed set the host itself offers in full, and every model
 * has to be reachable by the number printed next to it.
 *
 * Each model also carries its reasoning levels when it has any, because "which model" and "how hard
 * it thinks" are the two halves of the same choice: a list that showed only the first would send the
 * user back for a second question, and the level is not discoverable anywhere else on a phone.
 *
 * @param listing - Models on offer, and the selection the host reports.
 * @returns The message body.
 */
export function renderModelList(listing) {
    const models = listing.models;
    if (models.length === 0)
        return '当前没有可用的模型。';
    const current = listing.current;
    const currentName = current === undefined ? undefined : labelOfModel(current, models);
    const currentLevel = current === undefined
        ? undefined
        : levelName(current.reasoningEffort, models.find((option) => option.provider === current.provider && option.model === current.model)?.levels ?? []);
    const on = currentName === undefined ? '' : `，当前：${currentName}`;
    const at = currentLevel === undefined ? '' : ` · ${currentLevel}`;
    const header = `可用模型（共 ${String(models.length)} 个${on}${at}）：`;
    const rows = models.map((option, index) => renderModelRow(option, index, current));
    // Providers that failed are named rather than silently missing: a model that is simply absent
    // reads as a model the deployment does not have, which is a different thing to act on.
    const failures = listing.failures ?? [];
    const unavailable = failures.length === 0
        ? ''
        : `\n\n另有 ${String(failures.length)} 个提供方的模型这次没取到：${failures
            .map((failure) => `${failure.name}（${failure.message}）`)
            .join('、')}`;
    // Said only when some model actually has levels; an offer to change a setting nothing supports is
    // a promise the next reply has to break.
    const anyLevels = models.some((option) => (option.levels?.length ?? 0) > 0);
    const levelHint = anyLevels
        ? [`回复 /model 等级 <等级> 切换推理等级，例如 /model 等级 ${exampleLevelId(models)}。`]
        : [];
    return [
        header,
        '',
        rows.join('\n\n'),
        unavailable,
        '',
        '回复 /model 编号即可切换，也可以直接发模型名字。',
        ...levelHint,
    ].join('\n');
}
/**
 * A level id to print as the example.
 *
 * A model's *own default* rather than the first level it publishes: the first one is often `off`, and
 * an example that suggests turning thinking off is a poor thing to put in front of someone who just
 * asked to see more. Taken from the data either way, so it can never name a level that does not exist.
 */
function exampleLevelId(models) {
    for (const option of models) {
        const level = option.defaultLevel ?? option.levels?.[0]?.id;
        if (level !== undefined && level !== '')
            return level;
    }
    return '';
}
/**
 * Render one row of the model list.
 *
 * The label leads because it is what a person recognises; the provider and the id follow, because
 * two providers can offer the same id and the id is what the user may end up typing. The levels come
 * last, marked the same way the title is: the level in effect for the conversation's own model, and
 * the host's default for any other — which is the level a switch to it would land on.
 *
 * @param option - Model to render.
 * @param index - 0-based position, rendered as the 1-based number to reply with.
 * @param current - Selection the host reports, marked in the list.
 * @returns The row.
 */
function renderModelRow(option, index, current) {
    const isCurrent = current !== undefined && current.provider === option.provider && current.model === option.model;
    const mark = isCurrent ? '  ← 当前' : '';
    const provider = option.providerName.trim() === '' ? option.provider : option.providerName;
    const levels = option.levels ?? [];
    const inEffect = isCurrent ? current.reasoningEffort : option.defaultLevel;
    const levelMark = isCurrent ? '（当前）' : '（默认）';
    const levelLine = levels.length === 0
        ? []
        : [
            `   推理等级：${levels
                .map((level) => `${level.name}${level.id === inEffect ? levelMark : ''}`)
                .join(' · ')}`,
        ];
    return [`${String(index + 1)}. ${option.name}${mark}`, `   ${provider} · ${option.model}`, ...levelLine].join('\n');
}
/** What to call a selection in a heading: its label when it is on offer, else its id. */
function labelOfModel(selection, models) {
    const found = models.find((option) => option.provider === selection.provider && option.model === selection.model);
    return found?.name ?? selection.model;
}
/**
 * How long ago something happened, in the words a person would use.
 *
 * Relative rather than absolute because the question the list answers is "which one was I just
 * working on", and a 24-hour clock makes that harder, not easier. `昨天` appears because that is the
 * word people actually use for it, and it is the boundary a reader cares about most.
 *
 * @param at - Timestamp in milliseconds.
 * @param now - Current time, injectable so the wording is testable and one message stays consistent.
 * @returns A short phrase such as `3 分钟前`.
 */
export function relativeTime(at, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 60)
        return '刚刚';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours} 小时前`;
    // Whole days elapsed, not calendar days: a conversation 25 hours old was "昨天" by any reading the
    // user would give it, and matching their clock exactly is not worth a timezone.
    const days = Math.floor(hours / 24);
    if (days === 1)
        return '昨天';
    if (days < 7)
        return `${days} 天前`;
    return new Date(at).toLocaleDateString('zh-CN');
}
/**
 * The plain-text help.
 *
 * @returns The help text.
 */
export function helpText() {
    return [
        '可用指令：',
        ...COMMAND_HELP.map((entry) => `${entry.command}  ${entry.description}`),
        '',
        `每屏最多 ${String(BROWSE_PAGE_SIZE)} 条，编号跨屏连续；回复「${SHOW_REST}」看下十个。`,
        '列表就在眼前时，直接回编号、名字或行尾 6 位 id 即可，不必打 /切换。',
        '',
        '直接发消息即与当前对话对话。',
        '',
        '旧的英文名 /help /list /switch /model /current /cancel 也仍然可用。',
        '也可以直接用大白话说，例如「查看会话」「换个会话」「停下」，我会先问你一次确认。',
    ].join('\n');
}
export const HELP_TEXT = helpText();

//# sourceMappingURL=router.js.map