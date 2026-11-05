import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../src/', import.meta.url);
const safeSource = readFile(new URL('utils/safe_movements.js', root), 'utf8');
const LAVA = 10;

// Minimal Movements double: getBlock reads a sparse world; getNeighbors returns candidate moves.
async function load({ world = {}, dimension = 'overworld', inLava = false, lavaNearby = false } = {}) {
    class Movements {
        constructor() {
            Object.assign(this, { allowParkour: true, allowSprinting: true, dontCreateFlow: true });
            this.candidates = [];
        }
        getBlock(pos, dx, dy, dz) {
            const key = `${pos.x + dx},${pos.y + dy},${pos.z + dz}`;
            return { name: world[key] ?? (pos.y + dy === 63 ? 'netherrack' : 'air') };
        }
        getNeighbors() { return this.candidates.map(m => ({ ...m })); }
    }
    const context = vm.createContext({});
    const mod = new vm.SourceTextModule(await safeSource, { context });
    await mod.link(() => new vm.SyntheticModule(['default'], function () {
        this.setExport('default', { Movements });
    }, { context }));
    await mod.evaluate();
    const bot = {
        registry: { blocksByName: { lava: { id: LAVA } } },
        game: { dimension },
        entity: { isInLava: inLava },
        findBlocks: () => lavaNearby ? [{}] : []
    };
    return { safe: mod.namespace, bot, Movements };
}

const from = { x: 0, y: 64, z: 0 };
const move = (x, y, z, cost = 1) => ({ x, y, z, cost });

test('rejects stepping onto lava, magma, fire and campfire floors', async () => {
    for (const hazard of ['lava', 'magma_block', 'fire', 'soul_fire', 'campfire', 'soul_campfire']) {
        const { safe, bot, Movements } = await load({ world: { '1,63,0': hazard } });
        const m = safe.safeMovements(bot, new Movements());
        m.candidates = [move(1, 64, 0), move(-1, 64, 0)];
        assert.deepEqual(Array.from(m.getNeighbors(from), n => n.x), [-1], hazard);
    }
});

test('rejects entering lava or fire at feet or head height (source and flowing share the name)', async () => {
    for (const key of ['1,64,0', '1,65,0']) {
        const { safe, bot, Movements } = await load({ world: { [key]: 'lava' } });
        const m = safe.safeMovements(bot, new Movements());
        m.candidates = [move(1, 64, 0)];
        assert.equal(m.getNeighbors(from).length, 0, key);
    }
});

test('rejects drops that land on lava or magma', async () => {
    const { safe, bot, Movements } = await load({ world: { '1,59,0': 'magma_block', '1,60,0': 'air' } });
    const m = safe.safeMovements(bot, new Movements());
    m.candidates = [move(1, 60, 0)];
    assert.equal(m.getNeighbors(from).length, 0);
});

test('rejects parkour jumps over lava or magma gaps', async () => {
    for (const [key, hazard] of [['1,63,0', 'lava'], ['1,60,0', 'lava'], ['2,62,0', 'magma_block']]) {
        const { safe, bot, Movements } = await load({ world: { [key]: hazard } });
        const m = safe.safeMovements(bot, new Movements());
        m.candidates = [move(3, 64, 0)];
        assert.equal(m.getNeighbors(from).length, 0, key);
    }
});

test('rejects diagonal moves that cut a lava corner', async () => {
    const { safe, bot, Movements } = await load({ world: { '1,63,0': 'lava' } });
    const m = safe.safeMovements(bot, new Movements());
    m.candidates = [move(1, 64, 1)];
    assert.equal(m.getNeighbors(from).length, 0);
});

test('penalizes nodes beside lava but keeps safe neighbors unchanged', async () => {
    const { safe, bot, Movements } = await load({ world: { '2,63,0': 'lava' } });
    const m = safe.safeMovements(bot, new Movements());
    m.candidates = [move(1, 64, 0), move(-1, 64, 0)];
    const [beside, clear] = m.getNeighbors(from);
    assert.equal(beside.cost, 1 + safe.ADJACENT_LAVA_COST);
    assert.equal(clear.cost, 1);
});

test('disables parkour and sprinting in the Nether or near lava, not elsewhere', async () => {
    for (const [opts, expected] of [[{ dimension: 'the_nether' }, false], [{ dimension: 'minecraft:the_nether' }, false],
        [{ lavaNearby: true }, false], [{}, true]]) {
        const { safe, bot, Movements } = await load(opts);
        const m = safe.safeMovements(bot, new Movements());
        assert.equal(m.allowParkour, expected, JSON.stringify(opts));
        assert.equal(m.allowSprinting, expected, JSON.stringify(opts));
    }
});

test('dontCreateFlow cannot be switched off (collectblock plugin tries to)', async () => {
    const { safe, bot, Movements } = await load();
    const m = safe.safeMovements(bot, new Movements());
    m.dontCreateFlow = false;
    assert.equal(m.dontCreateFlow, true);
});

test('is idempotent and does not filter while already in lava so the bot can escape', async () => {
    const { safe, bot, Movements } = await load({ world: { '1,64,0': 'lava' }, inLava: true });
    const m = safe.safeMovements(bot, new Movements());
    assert.equal(safe.safeMovements(bot, m), m);
    m.candidates = [move(1, 64, 0)];
    assert.equal(m.getNeighbors(from).length, 1);
});

test('applyDefaultSafeMovements replaces pathfinder, pvp and collectblock defaults', async () => {
    const { safe, bot } = await load();
    let set = null;
    Object.assign(bot, { pathfinder: { setMovements: m => { set = m; } }, pvp: {}, collectBlock: {} });
    safe.applyDefaultSafeMovements(bot);
    assert.equal(set.hazardSafe, true);
    assert.equal(bot.pvp.movements.hazardSafe, true);
    assert.equal(bot.collectBlock.movements.hazardSafe, true);
});

async function sources(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) out.push(...await sources(url));
        else if (entry.name.endsWith('.js')) out.push([url.pathname, await readFile(url, 'utf8')]);
    }
    return out;
}

test('all routing code uses the shared hazard-aware movements', async () => {
    const files = await sources(root);
    for (const [path, text] of files) {
        if (path.endsWith('utils/safe_movements.js')) continue;
        assert.doesNotMatch(text, /new\s+(pf\.)?Movements\(/, `${path} constructs raw Movements`);
        for (const match of text.matchAll(/setMovements\(([^)]*)\)/g))
            assert.match(match[1], /safeMovements\(|^movements$|^move$|^final_movements$|^this\.movements$/, `${path}: ${match[0]}`);
    }
    const mcdata = files.find(([p]) => p.endsWith('utils/mcdata.js'))[1];
    assert.match(mcdata, /bot\.on\('spawn', \(\) => applyDefaultSafeMovements\(bot\)\)/);
    const skills = files.find(([p]) => p.endsWith('library/skills.js'))[1];
    for (const match of skills.matchAll(/(?:let|const) (\w+) = (.*Movements\(.*);/g))
        assert.match(match[2], /safeMovements\(bot\)/, match[0]);
});
