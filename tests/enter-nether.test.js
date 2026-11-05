import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const skillsSource = readFile(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
const actionsSource = readFile(new URL('../src/agent/commands/actions.js', import.meta.url), 'utf8');

class Position {
    constructor(x, y, z) { Object.assign(this, { x, y, z }); }
    offset(x, y, z) { return new Position(this.x + x, this.y + y, this.z + z); }
    distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); }
}

async function setup({ dimension = 'overworld', onTick = () => {}, onSearchTick = () => {}, reachable = () => true } = {}) {
    let now = 0;
    let navigationStart = 0;
    const bot = new EventEmitter();
    bot.output = '';
    bot.game = { dimension };
    bot.entity = { position: new Position(0, 64, 0) };
    bot.interrupt_code = false;
    const blocks = new Map();
    const add = (name, x, y, z, boundingBox = 'empty') => {
        const block = { name, position: new Position(x, y, z), boundingBox };
        blocks.set(`${x},${y},${z}`, block);
        return block;
    };
    const addPortal = (x = 4, z = 0) => {
        add('obsidian', x, 63, z, 'block');
        for (let y = 64; y < 67; y++) add('nether_portal', x, y, z);
    };
    bot.blockAt = pos => blocks.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) ?? null;
    bot.findBlocks = options => {
        bot.search = options;
        assert.equal(options.matching({ name: 'nether_portal' }), true);
        return [...blocks.values()].filter(block => options.matching(block) &&
            options.useExtraInfo(block) &&
            block.position.distanceTo(bot.entity.position) <= options.maxDistance)
            .slice(0, options.count).map(block => block.position);
    };
    const paused = new Set();
    bot.modes = {
        pause: name => paused.add(name),
        unpause: name => paused.delete(name)
    };
    bot.clearControlStates = () => { bot.controlsCleared = true; };
    bot.pathfinder = {
        goal: null,
        setMovements(movements) { this.movements = movements; },
        *getPathFromTo(movements, start, goal) {
            yield { result: { status: 'partial' } };
            yield { result: { status: reachable(goal) ? 'success' : 'noPath' } };
        },
        setGoal(goal) {
            this.goal = goal;
            if (goal) {
                bot.entryGoal = goal;
                navigationStart = now;
            }
        }
    };
    class Movements {}
    class GoalBlock extends Position {}
    const context = vm.createContext({
        Date: class extends Date { static now() { return now; } },
        setTimeout: resolve => {
            now += 100;
            if (bot.pathfinder.goal) onTick(bot, now - navigationStart);
            else onSearchTick(bot);
            resolve();
        }
    });
    const stub = value => new vm.SyntheticModule(['default'], function () {
        this.setExport('default', value);
    }, { context });
    const skills = new vm.SourceTextModule(await skillsSource, { context });
    await skills.link(specifier => {
        if (specifier === 'mineflayer-pathfinder') return stub({ Movements, goals: { GoalBlock } });
        if (specifier === 'vec3') return stub(Position);
        return stub({});
    });
    await skills.evaluate();
    const enter = () => skills.namespace.enterNether(bot);
    const assertClean = () => {
        assert.equal(bot.pathfinder.goal, null);
        assert.equal(bot.listenerCount('goal_reached'), 0);
        assert.equal(bot.listenerCount('path_update'), 0);
        assert.equal(paused.size, 0);
        assert.equal(bot.controlsCleared, true);
    };
    return { bot, add, addPortal, enter, assertClean, context, skills, stub };
}

function arrive(bot) {
    const goal = bot.pathfinder.goal;
    bot.entity.position = new Position(goal.x + 0.5, goal.y, goal.z + 0.5);
    bot.emit('goal_reached', goal);
}

test('selects a supported bottom block, enters it, and waits for Nether dimension', async () => {
    const fixture = await setup({
        onTick(bot, now) {
            if (now === 100) arrive(bot);
            if (now === 4100) bot.game.dimension = 'the_nether';
        }
    });
    fixture.addPortal();
    assert.equal(await fixture.enter(), true);
    assert.equal(fixture.bot.entryGoal.y, 64);
    assert.equal(fixture.bot.entryGoal.x, 4);
    assert.equal(fixture.bot.pathfinder.movements.canDig, false);
    assert.equal(fixture.bot.pathfinder.movements.allow1by1towers, false);
    assert.equal(fixture.bot.pathfinder.movements.scafoldingBlocks.length, 0);
    assert.match(fixture.bot.output, /waiting up to 15 seconds/);
    assert.match(fixture.bot.output, /Successfully entered/);
    fixture.assertClean();
});

test('tries another entry when the nearest bottom block is unreachable', async () => {
    const fixture = await setup({
        reachable: goal => goal.x === 8,
        onTick(bot) { bot.game.dimension = 'minecraft:the_nether'; }
    });
    fixture.addPortal();
    fixture.addPortal(8);
    assert.equal(await fixture.enter(), true);
    assert.equal(fixture.bot.entryGoal.x, 8);
    fixture.assertClean();
});

test('no portal, unloaded support, unsupported blocks and obstructed headroom are rejected', async () => {
    for (const kind of ['missing', 'unsupported', 'upper-only', 'headroom', 'unloaded', 'distant']) {
        const fixture = await setup();
        if (kind === 'unsupported') {
            fixture.addPortal();
            fixture.add('air', 4, 63, 0);
        }
        if (kind === 'upper-only') fixture.add('nether_portal', 4, 65, 0);
        if (kind === 'headroom') {
            fixture.addPortal();
            fixture.add('stone', 4, 65, 0, 'block');
        }
        if (kind === 'unloaded') {
            fixture.add('nether_portal', 4, 64, 0);
            fixture.add('nether_portal', 4, 65, 0);
        }
        if (kind === 'distant') fixture.addPortal(100);
        assert.equal(await fixture.enter(), false, kind);
        assert.match(fixture.bot.output, /No active Nether portal/);
        assert.equal(fixture.bot.pathfinder.goal, null);
    }
});

test('already in the Nether never navigates back', async () => {
    for (const dimension of ['the_nether', 'minecraft:the_nether', 'nether']) {
        const fixture = await setup({ dimension });
        fixture.addPortal();
        assert.equal(await fixture.enter(), false);
        assert.match(fixture.bot.output, /Already in the Nether/);
        assert.equal(fixture.bot.search, undefined);
    }
});

test('other dimensions are rejected without navigating', async () => {
    const fixture = await setup({ dimension: 'the_end' });
    assert.equal(await fixture.enter(), false);
    assert.match(fixture.bot.output, /Cannot enter the Nether/);
});

test('a pending interrupt prevents any search or movement', async () => {
    const fixture = await setup();
    fixture.bot.interrupt_code = true;
    assert.equal(await fixture.enter(), false);
    assert.match(fixture.bot.output, /interrupted/);
    assert.equal(fixture.bot.search, undefined);
});

test('path selection yields so stop can interrupt between candidate searches', async () => {
    const fixture = await setup({
        reachable: () => false,
        onSearchTick(bot) { bot.interrupt_code = true; }
    });
    fixture.addPortal();
    fixture.addPortal(8);
    assert.equal(await fixture.enter(), false);
    assert.match(fixture.bot.output, /interrupted/);
    assert.equal(fixture.bot.pathfinder.goal, null);
});

test('unreachable portal reports failure without attempting destructive navigation', async () => {
    const fixture = await setup({ reachable: () => false });
    fixture.addPortal();
    assert.equal(await fixture.enter(), false);
    assert.match(fixture.bot.output, /No reachable Nether portal/);
    assert.equal(fixture.bot.pathfinder.goal, null);
});

test('arrival alone is not success and transfer wait is bounded', async () => {
    const fixture = await setup({ onTick(bot, now) { if (now === 100) arrive(bot); } });
    fixture.addPortal();
    assert.equal(await fixture.enter(), false);
    assert.match(fixture.bot.output, /transfer timed out \(15 seconds\)/);
    assert.doesNotMatch(fixture.bot.output, /Successfully entered/);
    fixture.assertClean();
});

test('navigation itself is bounded', async () => {
    const fixture = await setup();
    fixture.addPortal();
    assert.equal(await fixture.enter(), false);
    assert.match(fixture.bot.output, /Timed out reaching.*30 seconds/);
    fixture.assertClean();
});

test('interrupt during navigation or portal wait cleans up immediately', async () => {
    for (const phase of ['navigation', 'wait']) {
        const fixture = await setup({
            onTick(bot, now) {
                if (phase === 'wait' && now === 100) arrive(bot);
                if (now === 200) bot.interrupt_code = true;
            }
        });
        fixture.addPortal();
        assert.equal(await fixture.enter(), false);
        assert.match(fixture.bot.output, /interrupted/);
        fixture.assertClean();
    }
});

test('path becoming unreachable is reported and cleaned up', async () => {
    const fixture = await setup({ onTick(bot) { bot.emit('path_update', { status: 'noPath' }); } });
    fixture.addPortal();
    assert.equal(await fixture.enter(), false);
    assert.match(fixture.bot.output, /no longer reachable/);
    fixture.assertClean();
});

test('dimension transfer during navigation takes precedence over path reset', async () => {
    const fixture = await setup({
        onTick(bot) {
            bot.game.dimension = 'the_nether';
            bot.emit('path_update', { status: 'noPath' });
        }
    });
    fixture.addPortal();
    assert.equal(await fixture.enter(), true);
    fixture.assertClean();
});

test('an unrelated dimension change is not reported as success', async () => {
    const fixture = await setup({ onTick(bot) { bot.game.dimension = 'the_end'; } });
    fixture.addPortal();
    assert.equal(await fixture.enter(), false);
    assert.match(fixture.bot.output, /unexpected dimension/);
    fixture.assertClean();
});

test('goal event outside the portal does not claim successful arrival', async () => {
    const fixture = await setup({ onTick(bot) { bot.emit('goal_reached', bot.pathfinder.goal); } });
    fixture.addPortal();
    assert.equal(await fixture.enter(), false);
    assert.match(fixture.bot.output, /outside the Nether portal/);
    fixture.assertClean();
});

test('navigation exceptions propagate after cleanup', async () => {
    const fixture = await setup();
    fixture.addPortal();
    fixture.bot.pathfinder.setMovements = () => { throw new Error('test navigation failure'); };
    await assert.rejects(fixture.enter(), /test navigation failure/);
    fixture.assertClean();
});

test('command uses the standard action wrapper without resuming or altering block search', async () => {
    const fixture = await setup();
    const actions = new vm.SourceTextModule(await actionsSource, { context: fixture.context });
    await actions.link(specifier => specifier.endsWith('/skills.js') ? fixture.skills : fixture.stub({}));
    await actions.evaluate();
    const command = actions.namespace.actionsList.find(action => action.name === '!enterNether');
    let executed = false;
    const agent = {
        bot: fixture.bot,
        actions: {
            async runAction(label, action, options) {
                assert.equal(label, 'action:enterNether');
                assert.equal(options.resume, false);
                await action();
                executed = true;
                return { message: fixture.bot.output };
            }
        }
    };
    assert.match(await command.perform(agent), /No active Nether portal/);
    assert.equal(executed, true);
    const search = actions.namespace.actionsList.find(action => action.name === '!searchForBlock');
    assert.match(search.perform.toString(), /runAction/);
    assert.match(await actionsSource, /goToNearestBlock\(agent.bot, block_type, 4, range\)/);
});
