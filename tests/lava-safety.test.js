import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const skillsSource = readFile(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
const LAVA = 10;

class Position {
    constructor(x, y, z) { Object.assign(this, { x, y, z }); }
    offset(x, y, z) { return new Position(this.x + x, this.y + y, this.z + z); }
    floored() { return new Position(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
    clone() { return new Position(this.x, this.y, this.z); }
    distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
}

async function setup({ lava = [], entities = [], inLava = false, start = [0, 64, 0] } = {}) {
    const bot = new EventEmitter();
    bot.output = '';
    bot.registry = { blocksByName: { lava: { id: LAVA } } };
    bot.entity = { position: new Position(...start), isInLava: inLava };
    bot.inventory = { items: () => [] };
    bot.interrupt_code = false;
    const blocks = new Map();
    const set = (name, x, y, z, boundingBox, type = 1) =>
        blocks.set(`${x},${y},${z}`, { name, type, boundingBox, position: new Position(x, y, z) });
    for (let x = -8; x <= 8; x++)
        for (let z = -8; z <= 8; z++) set('netherrack', x, 63, z, 'block');
    for (const [x, y, z] of lava) set('lava', x, y, z, 'empty', LAVA);
    bot.blockAt = pos => {
        const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
        if (blocks.has(key)) return blocks.get(key);
        if (Math.abs(pos.x) > 8 || Math.abs(pos.z) > 8) return null;
        return { name: 'air', type: 0, boundingBox: 'empty', position: new Position(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)) };
    };
    bot.findBlocks = ({ matching, useExtraInfo, maxDistance, count }) => [...blocks.values()]
        .filter(b => (typeof matching === 'number' ? b.type === matching : matching(b)) &&
            (!useExtraInfo || useExtraInfo(b)) && b.position.distanceTo(bot.entity.position) <= maxDistance)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
        .slice(0, count).map(b => b.position);
    bot.events = [];
    bot.pathfinder = {
        getPathTo: () => ({ status: 'success' }),
        setMovements(m) { this.movements = m; },
        stop() {},
        async goto(goal) {
            bot.events.push(['goto', goal]);
            if (goal.kind === 'block') bot.entity.position = new Position(goal.x + 0.5, goal.y, goal.z + 0.5);
        }
    };
    bot.pvp = {
        movements: null,
        attack(entity) {
            bot.events.push(['attack', entity.name, this.movements]);
            entities.splice(entities.indexOf(entity), 1);
        },
        stop() { bot.events.push(['stop']); }
    };
    bot.modes = { pause() {}, unpause() {} };
    bot.clearControlStates = () => {};

    class Movements {
        constructor() {
            Object.assign(this, { allowParkour: true, allowSprinting: true, exclusionAreasStep: [],
                exclusionAreasPlace: [], exclusionAreasBreak: [], blocksCantBreak: new Set() });
        }
    }
    const goals = {
        GoalBlock: class { constructor(x, y, z) { Object.assign(this, { x, y, z, kind: 'block' }); } },
        GoalFollow: class { constructor(e, r) { Object.assign(this, { e, r, kind: 'follow' }); } },
        GoalInvert: class { constructor(g) { Object.assign(this, { g, kind: 'invert' }); } },
        GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r, kind: 'near' }); } }
    };
    const world = {
        getNearestEntityWhere: (b, pred, range) => entities
            .filter(e => pred(e) && e.position.distanceTo(b.entity.position) <= range)
            .sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0] ?? null,
        getNearbyEntities: () => [...entities],
        getNearestBlock: () => null,
        shouldPlaceTorch: () => false
    };
    const mc = { isHostile: e => !!e.hostile, getBlockId: () => 1 };
    const context = vm.createContext({ setTimeout, clearTimeout, setInterval, clearInterval, console });
    const stub = value => new vm.SyntheticModule(Object.keys(value).concat(value.default ? [] : ['default']), function () {
        for (const [k, v] of Object.entries(value)) this.setExport(k, v);
        if (!value.default) this.setExport('default', value);
    }, { context });
    const skills = new vm.SourceTextModule(await skillsSource, { context });
    await skills.link(spec => {
        if (spec === 'mineflayer-pathfinder') return stub({ default: { Movements, goals } });
        if (spec === 'vec3') return stub({ default: Position });
        if (spec.endsWith('world.js')) return stub(world);
        if (spec.endsWith('mcdata.js')) return stub(mc);
        return stub({ default: {} });
    });
    await skills.evaluate();
    return { bot, s: skills.namespace, entities, Position, Movements };
}

const at = (x, y, z) => ({ position: new Position(x, y, z) });

test('isNearLava and isSafeFooting detect lava edges, missing floor and lava below', async () => {
    const { bot, s } = await setup({ lava: [[2, 63, 0]] });
    assert.equal(s.isNearLava(bot, new Position(1, 64, 0)), true);
    assert.equal(s.isNearLava(bot, new Position(-2, 64, 0)), false);
    assert.equal(s.isSafeFooting(bot, new Position(1, 64, 0)), false);
    assert.equal(s.isSafeFooting(bot, new Position(-2, 64, 0)), true);
    assert.equal(s.isSafeFooting(bot, new Position(2, 64, 0)), false);
    assert.equal(s.isSafeFooting(bot, new Position(-2, 70, 0)), false);
});

test('lavaSafeMovements is a no-op without nearby lava', async () => {
    const { s } = await setup({ start: [0, 64, 0] });
    const m = s.lavaSafeMovements({ entity: { position: new Position(0, 64, 0) }, registry: { blocksByName: { lava: { id: LAVA } } }, findBlocks: () => [] });
    assert.equal(m.allowParkour, true);
    assert.equal(m.exclusionAreasStep.length, 0);
});

test('lavaSafeMovements penalizes lava edges and blocks parkour, sprinting, bridging and digging above lava', async () => {
    const { bot, s } = await setup({ lava: [[3, 63, 0]] });
    const m = s.lavaSafeMovements(bot);
    assert.equal(m.allowParkour, false);
    assert.equal(m.allowSprinting, false);
    assert.equal(m.lavaSafe, true);
    const step = pos => m.exclusionAreasStep.reduce((c, f) => c + f(at(...pos)), 0);
    assert.equal(step([2, 64, 0]), 25);
    assert.equal(step([-3, 64, 0]), 0);
    assert.equal(m.exclusionAreasPlace[0](at(2, 63, 0)), 100);
    assert.equal(m.exclusionAreasBreak[0](at(3, 64, 0)), 100);
    assert.equal(m.exclusionAreasBreak[0](at(0, 64, 0)), 0);
});

test('lavaSafeMovements leaves lava passable when the bot must escape from lava', async () => {
    const { bot, s } = await setup({ lava: [[0, 63, 0]], inLava: true });
    const m = s.lavaSafeMovements(bot);
    assert.equal(m.allowParkour, true);
    assert.equal(m.exclusionAreasStep.length, 0);
});

test('moveToSafeGround escapes onto the nearest safe block away from lava', async () => {
    const lava = [];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) lava.push([x, 63, z]);
    const { bot, s } = await setup({ lava, inLava: true, start: [0, 63.5, 0] });
    assert.equal(await s.moveToSafeGround(bot, null, 10), true);
    assert.equal(s.isSafeFooting(bot, bot.entity.position.floored()), true);
    assert.match(bot.output, /Moved to safe ground/);
});

test('defendSelf repositions to safe footing before attacking and chases with lava-safe movements', async () => {
    const entities = [];
    const fixture = await setup({ lava: [[1, 63, 0]], entities });
    entities.push({ name: 'magma_cube', hostile: true, position: new Position(0, 64, -3) });
    const { bot, s } = fixture;
    assert.equal(await s.defendSelf(bot, 8), true);
    const gotoIndex = bot.events.findIndex(e => e[0] === 'goto' && e[1].kind === 'block');
    const attackIndex = bot.events.findIndex(e => e[0] === 'attack');
    assert.ok(gotoIndex >= 0 && attackIndex > gotoIndex, JSON.stringify(bot.events.map(e => e[0])));
    assert.equal(bot.events[attackIndex][2].lavaSafe, true);
    assert.match(bot.output, /repositioning before fighting/);
    assert.equal(s.isSafeFooting(bot, bot.entity.position.floored()), true);
});

test('defendSelf does not chase an enemy standing near lava', async () => {
    const entities = [];
    const fixture = await setup({ lava: [[6, 63, 0]], entities, start: [-3, 64, 0] });
    entities.push({ name: 'magma_cube', hostile: true, position: new Position(5, 64, 0) });
    const { bot, s } = fixture;
    assert.equal(await s.defendSelf(bot, 9), false);
    assert.equal(bot.events.some(e => e[0] === 'attack' || e[0] === 'goto'), false);
});

test('attackEntity refuses to pursue a target near lava', async () => {
    const entities = [];
    const fixture = await setup({ lava: [[6, 63, 0]], entities, start: [-3, 64, 0] });
    const cube = { name: 'magma_cube', hostile: true, position: new Position(5, 64, 0) };
    entities.push(cube);
    const { bot, s } = fixture;
    assert.equal(await s.attackEntity(bot, cube, true), false);
    assert.match(bot.output, /Not chasing magma_cube: it is near lava/);
    assert.equal(bot.events.some(e => e[0] === 'attack'), false);
});

test('disengages when no safe footing can be reached', async () => {
    const entities = [];
    const fixture = await setup({ lava: [[1, 63, 0]], entities });
    const cube = { name: 'magma_cube', hostile: true, position: new Position(0, 64, -2.5) };
    entities.push(cube);
    const { bot, s } = fixture;
    bot.findBlocks = () => [];
    assert.equal(await s.attackEntity(bot, cube, true), false);
    assert.match(bot.output, /Disengaging from magma_cube: no safe footing/);
    assert.equal(bot.events.some(e => e[0] === 'attack'), false);
});
