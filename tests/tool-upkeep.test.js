import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = readFile(new URL('../src/agent/library/tool_upkeep.js', import.meta.url), 'utf8');
const safeSource = readFile(new URL('../src/utils/safe_movements.js', import.meta.url), 'utf8');
class Position {
    constructor(x, y, z) { Object.assign(this, { x, y, z }); }
    clone() { return new Position(this.x, this.y, this.z); }
    offset(x, y, z) { return new Position(this.x + x, this.y + y, this.z + z); }
    minus(p) { return this.offset(-p.x, -p.y, -p.z); }
    floored() { return new Position(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
    distanceTo(p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z); }
}

async function setup(inventory = {}, options = {}) {
    const items = { ...inventory };
    const events = [];
    const blocks = new Map();
    let now = 0;
    let drop = null;
    const add = (name, x, y = 64, z = 0) => {
        const block = { name, position: new Position(x, y, z), boundingBox: 'block',
            canHarvest: () => name.endsWith('_log') || name.endsWith('_stem') ||
                Object.keys(items).some(key => key.endsWith('_pickaxe') && items[key] > 0) };
        blocks.set(`${x},${y},${z}`, block);
        return block;
    };
    if (options.table !== false) add('crafting_table', 2);
    for (const [name, x, y, z] of options.blocks || []) add(name, x, y, z);
    const names = ['stick', 'crafting_table', 'oak_planks', 'crimson_planks', 'stone_sword',
        'stone_pickaxe', 'wooden_pickaxe', 'lava'];
    const byName = Object.fromEntries(names.map((name, id) => [name, { id }]));
    const count = predicate => Object.entries(items).reduce((n, [name, amount]) =>
        n + (predicate(name) ? amount : 0), 0);
    const isRock = name => ['cobblestone', 'blackstone', 'cobbled_deepslate'].includes(name);
    const ingredients = name => {
        if (name.endsWith('_planks')) return [[name.replace('_planks', name === 'crimson_planks' ? '_stem' : '_log'), 1]];
        if (name === 'crafting_table') return [['planks', 4]];
        if (name === 'stick') return [['planks', 2]];
        return [[name.startsWith('wooden') ? 'planks' : 'rock', name.endsWith('sword') ? 2 : 3],
            ['stick', name.endsWith('sword') ? 1 : 2]];
    };
    const matches = (key, name) => key === 'planks' ? name.endsWith('_planks') : key === 'rock' ? isRock(name) : key === name;
    const bot = {
        entity: { position: new Position(0, 64, 0) }, game: { dimension: options.dimension || 'overworld' },
        inventory: { items: () => Object.entries(items).filter(([, n]) => n > 0).map(([name, amount]) =>
            ({ name, count: amount, type: name })) },
        registry: { itemsByName: byName, blocksByName: { ...byName, oak_log: {}, crimson_stem: {} } },
        blockAt(pos) {
            return blocks.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) ||
                { name: pos.y < 64 ? 'netherrack' : 'air', boundingBox: pos.y < 64 ? 'block' : 'empty', position: pos.clone() };
        },
        findBlocks({ matching, maxDistance }) {
            if (typeof matching !== 'function') return [];
            return [...blocks.values()].filter(b => matching(b) &&
                b.position.distanceTo(bot.entity.position) <= maxDistance).map(b => b.position);
        },
        recipesFor(id, metadata, amount, table) {
            const name = names[id];
            if ((name.endsWith('pickaxe') || name.endsWith('sword')) && !table) return [];
            return ingredients(name).every(([key, required]) => count(n => matches(key, n)) >= required) ? [{ name }] : [];
        },
        async craft({ name }) {
            events.push(['craft', name]);
            for (const [key, amount] of ingredients(name)) {
                let remaining = amount;
                for (const item of Object.keys(items).filter(n => matches(key, n))) {
                    const used = Math.min(remaining, items[item]);
                    items[item] -= used;
                    remaining -= used;
                }
            }
            items[name] = (items[name] || 0) + (name.endsWith('_planks') || name === 'stick' ? 4 : 1);
            if (options.timeout) now += 61000;
        },
        async equip(item) { bot.heldItem = item; },
        tool: { async equipForBlock() {
            bot.heldItem = bot.inventory.items().find(item => item.name.endsWith('_pickaxe'));
            if (options.interrupt) bot.interrupt_code = true;
        } },
        async dig(block) {
            events.push(['dig', block.name]);
            blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`);
            drop = block.name === 'stone' ? 'cobblestone' : block.name === 'deepslate' ? 'cobbled_deepslate' : block.name;
        },
        async placeBlock(support) {
            items.crafting_table--;
            add('crafting_table', support.position.x, support.position.y + 1, support.position.z);
            events.push(['place', 'crafting_table']);
        }
    };
    class Movements {
        constructor() { this.canDig = true; }
        getBlock(pos, x, y, z) { return bot.blockAt(new Position(pos.x + x, pos.y + y, pos.z + z)); }
        getNeighbors() { return []; }
        safeToBreak() { return this.canDig && options.unsafeBreak !== true; }
    }
    bot.pathfinder = {
        setMovements(m) { this.movements = m; },
        getPathTo() { return { status: options.noPath ? 'noPath' : 'success' }; },
        async goto(goal) {
            events.push(['goto', goal]);
            bot.entity.position = new Position(goal.x - (goal.radius >= 2 ? 2 : 0), goal.y, goal.z);
            if (drop && goal.radius < 1 && !options.noPickup) {
                items[drop] = (items[drop] || 0) + 1;
                drop = null;
            }
        }
    };
    const context = vm.createContext({ Date: { now: () => now }, setTimeout: fn => fn() });
    const pf = () => new vm.SyntheticModule(['default'], function () {
        this.setExport('default', { Movements, goals: { GoalNear: class {
            constructor(x, y, z, radius) { Object.assign(this, { x, y, z, radius }); }
        } } });
    }, { context });
    const safe = new vm.SourceTextModule(await safeSource, { context });
    await safe.link(pf);
    await safe.evaluate();
    const mod = new vm.SourceTextModule(await source, { context });
    await mod.link(name => name === 'mineflayer-pathfinder' ? pf() : safe);
    await mod.evaluate();
    return { bot, api: mod.namespace, events, items };
}

test('stone or better satisfies each tool independently; wooden and golden do not', async () => {
    for (const tier of ['stone', 'iron', 'diamond', 'netherite']) {
        const { api, bot } = await setup({ [`${tier}_sword`]: 1, [`${tier}_pickaxe`]: 1 });
        assert.equal(api.missingTools(bot).length, 0);
    }
    const { api, bot } = await setup({ golden_sword: 1, wooden_pickaxe: 1 });
    assert.equal(api.missingTools(bot).length, 2);
});

test('crafts only the missing tool and keeps better tools', async () => {
    const { api, bot, events, items } = await setup({ diamond_sword: 1, blackstone: 3, stick: 2 });
    await api.maintainTools(bot);
    assert.deepEqual(events.filter(e => e[0] === 'craft'), [['craft', 'stone_pickaxe']]);
    assert.equal(items.diamond_sword, 1);
    assert.equal(bot.pathfinder.movements.hazardSafe, true);
    assert.equal(bot.pathfinder.movements.canDig, false);
});

test('does nothing when both tools already satisfy upkeep', async () => {
    const { api, bot, events } = await setup({ iron_sword: 1, stone_pickaxe: 1 });
    await api.maintainTools(bot);
    assert.equal(events.length, 0);
});

test('crafts table, sticks and basic tools from inventory without unnecessary wooden pickaxe', async () => {
    const { api, bot, items, events } = await setup({ oak_log: 3, cobblestone: 5 }, { table: false });
    await api.maintainTools(bot);
    assert.equal(items.stone_sword, 1);
    assert.equal(items.stone_pickaxe, 1);
    assert.equal(events.some(e => e[1] === 'wooden_pickaxe'), false);
    assert.equal(events.some(e => e[0] === 'place'), true);
});

test('bootstraps a wooden pickaxe and gathers only five nearby stones', async () => {
    const blocks = Array.from({ length: 5 }, (_, i) => ['stone', 3, 64, i - 2]);
    const { api, bot, items, events } = await setup({ oak_log: 4 }, { blocks });
    await api.maintainTools(bot);
    assert.equal(items.stone_sword, 1);
    assert.equal(items.stone_pickaxe, 1);
    assert.equal(events.filter(e => e[0] === 'dig').length, 5);
    assert.equal(events.filter(e => e[1] === 'wooden_pickaxe').length, 1);
    assert.equal(events.filter(e => e[0] === 'goto').every(e =>
        Math.hypot(e[1].x, e[1].y - 64, e[1].z) <= 8), true);
});

test('supports nearby Nether stem wood and blackstone without dimension travel', async () => {
    const { api, bot, items } = await setup({ crimson_stem: 3, blackstone: 5 }, { dimension: 'the_nether' });
    await api.maintainTools(bot);
    assert.equal(items.stone_sword, 1);
    assert.equal(items.stone_pickaxe, 1);
    assert.equal(bot.game.dimension, 'the_nether');
});

test('refuses unavailable or unsafe materials, routes, pickup failure and interruption', async () => {
    for (const options of [
        {}, { blocks: [['oak_log', 20]] }, { blocks: [['oak_log', 3]], unsafeBreak: true },
        { blocks: [['oak_log', 3], ['lava', 4, 63, 0]] },
        { blocks: [['oak_log', 3], ['sand', 3, 65, 0]] },
        { blocks: [['oak_log', 3], ['magma_block', 0, 63, 0]] },
        { blocks: [['oak_log', 3]], noPath: true }, { blocks: [['oak_log', 3]], noPickup: true },
        { blocks: [['oak_log', 3]], interrupt: true }
    ]) {
        const { api, bot } = await setup({}, options);
        await assert.rejects(api.maintainTools(bot));
    }
});

test('respects time limit and inventory-only restrictions', async () => {
    const timed = await setup({ oak_log: 2 }, { timeout: true });
    await assert.rejects(timed.api.maintainTools(timed.bot), /limit/);
    const restricted = await setup({}, { blocks: [['oak_log', 3]] });
    restricted.bot.restrict_to_inventory = true;
    await assert.rejects(restricted.api.maintainTools(restricted.bot), /disabled/);
});

test('idle trigger delays ten seconds, gives human tasks priority, and suppresses unchanged retries', async () => {
    const { api, bot } = await setup();
    const agent = { bot, isIdle: () => true, actions: {}, self_prompter: { isActive: () => false } };
    const state = {};
    assert.equal(api.upkeepReady(agent, state, 0), false);
    assert.equal(api.upkeepReady(agent, state, 10000), true);
    for (const change of [
        { pendingMessages: 1 }, { shut_up: true }, { isIdle: () => false },
        { actions: { resume_func: () => {} } }, { task: { data: {} } },
        { self_prompter: { isActive: () => true } }
    ]) assert.equal(api.upkeepReady({ ...agent, ...change }, {}, 20000), false);
    state.lastKey = api.upkeepKey(bot);
    assert.equal(api.upkeepReady(agent, state, 300000), false);
    bot.entity.position.x = 9;
    state.nextAttempt = 400000;
    assert.equal(api.upkeepReady(agent, state, 300000), false);
    assert.equal(api.upkeepReady(agent, state, 400000), true);
});

test('can gather wood nearby rather than requiring starting materials', async () => {
    const blocks = [['oak_log', 3, 64, 1], ['oak_log', 3, 64, 2], ['oak_log', 3, 64, 3],
        ...Array.from({ length: 5 }, (_, i) => ['stone', 4, 64, i - 2])];
    const { api, bot, items } = await setup({}, { blocks });
    await api.maintainTools(bot);
    assert.equal(items.stone_sword, 1);
    assert.equal(items.stone_pickaxe, 1);
});

test('real mode controller triggers upkeep on idle, stops repetition, and supports disabling', async () => {
    const { api, bot } = await setup();
    let now = 0;
    let calls = 0;
    let conversation = false;
    const messages = [];
    const agent = {
        bot, isIdle: () => true, actions: { currentActionLabel: '', resume_func: null,
            async runAction(label, fn) { await fn(); return { message: '', interrupted: false }; } },
        self_prompter: { isActive: () => false },
        prompter: { getInitModes: () => ({ basic_upkeep: true }) },
        openChat: message => messages.push(message)
    };
    const context = vm.createContext({ Date: { now: () => now }, console: { log() {}, warn() {} } });
    const stub = values => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
    const mode = new vm.SourceTextModule(await readFile(new URL('../src/agent/modes.js', import.meta.url), 'utf8'), { context });
    await mode.link(spec => {
        if (spec.endsWith('tool_upkeep.js')) return stub({
            maintainTools: async () => { calls++; throw new Error('No nearby materials'); },
            upkeepKey: api.upkeepKey, upkeepReady: (a, s) => api.upkeepReady(a, s, now)
        });
        if (spec.endsWith('settings.js')) return stub({ default: { narrate_behavior: true } });
        if (spec.endsWith('conversation.js')) return stub({ default: { inConversation: () => conversation } });
        return stub({});
    });
    await mode.evaluate();
    mode.namespace.initModes(agent);
    for (const name of Object.keys(bot.modes.getJson())) if (name !== 'basic_upkeep') bot.modes.setOn(name, false);
    await bot.modes.update();
    now = 10000;
    await bot.modes.update();
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    assert.equal(messages.length, 1);
    now = 400000;
    await bot.modes.update();
    assert.equal(calls, 1);
    bot.modes.setOn('basic_upkeep', false);
    bot.entity.position.x = 9;
    await bot.modes.update();
    assert.equal(calls, 1);
    bot.modes.setOn('basic_upkeep', true);
    now += 10000;
    conversation = true;
    await bot.modes.update();
    assert.equal(calls, 1);
    conversation = false;
    now += 10000;
    await bot.modes.update();
    await new Promise(setImmediate);
    assert.equal(calls, 2);
});

test('message boundary stops upkeep before handling a human order, and always clears busy guard', async () => {
    const agentSource = await readFile(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    const wrapper = agentSource.slice(agentSource.indexOf('    async handleMessage('),
        agentSource.indexOf('    async _handleMessage('));
    const Agent = vm.runInNewContext(`(class { ${wrapper} })`,
        { convoManager: { isOtherAgent: () => false } });
    const agent = new Agent();
    const events = [];
    agent.name = 'test-bot';
    agent.actions = { currentActionLabel: 'mode:basic_upkeep',
        async stop() { assert.equal(agent.pendingMessages, 1); events.push('stop'); } };
    agent._handleMessage = async () => { events.push('order'); throw new Error('test error'); };
    await assert.rejects(agent.handleMessage('human', 'follow me'), /test error/);
    assert.deepEqual(events, ['stop', 'order']);
    assert.equal(agent.pendingMessages, 0);
});
