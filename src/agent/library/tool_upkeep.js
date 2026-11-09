import pf from 'mineflayer-pathfinder';
import { safeMovements, isNextToLava, FLOOR_HAZARDS } from '../../utils/safe_movements.js';

const TIERS = ['stone', 'iron', 'diamond', 'netherite'];
const RANGE = 8;
const ROCKS = ['stone', 'cobblestone', 'blackstone', 'cobbled_deepslate', 'deepslate'];
const counts = bot => {
    const result = {};
    for (const item of bot.inventory.items()) result[item.name] = (result[item.name] || 0) + item.count;
    return result;
};

export function missingTools(bot) {
    const inventory = counts(bot);
    return ['sword', 'pickaxe'].filter(tool => !TIERS.some(tier => inventory[`${tier}_${tool}`] > 0));
}

export function upkeepKey(bot) {
    const pos = bot.entity.position;
    return JSON.stringify([bot.game.dimension, Math.floor(pos.x / RANGE), Math.floor(pos.y / RANGE),
        Math.floor(pos.z / RANGE), Object.entries(counts(bot)).sort()]);
}

export function upkeepReady(agent, state, now = Date.now()) {
    if (!agent.isIdle() || agent.pendingMessages || agent.shut_up || agent.actions.resume_func ||
        agent.self_prompter.isActive() || agent.task?.data || agent.bot.interrupt_code) {
        state.idleSince = now;
        return false;
    }
    state.idleSince ??= now;
    return now - state.idleSince >= 10000 && now >= (state.nextAttempt || 0) &&
        missingTools(agent.bot).length > 0 && upkeepKey(agent.bot) !== state.lastKey;
}

export async function maintainTools(bot) {
    const origin = bot.entity.position.clone();
    const dimension = bot.game.dimension;
    const deadline = Date.now() + 60000;
    const check = () => {
        if (bot.interrupt_code) throw new Error('Upkeep interrupted');
        if (Date.now() >= deadline || bot.game.dimension !== dimension ||
            origin.distanceTo(bot.entity.position) > RANGE) throw new Error('Upkeep local/time limit reached');
    };
    const movements = safeMovements(bot);
    movements.canDig = false;
    movements.allowParkour = false;
    movements.allowSprinting = false;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];
    const digging = safeMovements(bot);
    digging.canDig = true;
    const neighbors = movements.getNeighbors.bind(movements);
    movements.getNeighbors = node => neighbors(node).filter(move =>
        Math.hypot(move.x - origin.x, move.y - origin.y, move.z - origin.z) <= RANGE &&
        !isNextToLava(movements, move));
    const safeBlock = block => block && origin.distanceTo(block.position) <= RANGE &&
        !isNextToLava(movements, block.position) && !FLOOR_HAZARDS.has(block.name);
    const nearby = names => bot.findBlocks({
        matching: block => names.includes(block.name), maxDistance: RANGE, count: 32
    }).map(pos => bot.blockAt(pos)).filter(safeBlock);

    async function approach(block, radius) {
        check();
        bot.pathfinder.setMovements(movements);
        const pos = block.position;
        const goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, radius);
        if (bot.pathfinder.getPathTo(movements, goal, 500).status !== 'success')
            throw new Error('No safe nearby route');
        await bot.pathfinder.goto(goal);
        check();
    }

    async function gather(names) {
        check();
        if (bot.restrict_to_inventory) throw new Error('Gathering is disabled for this task');
        for (const block of nearby(names)) {
            // Never mine our footing or overhead blocks that could release falling blocks.
            if (block.position.y < bot.entity.position.y - 1 ||
                (Math.abs(block.position.x - bot.entity.position.x) < 1 &&
                 Math.abs(block.position.z - bot.entity.position.z) < 1)) continue;
            if (!digging.safeToBreak(block)) continue;
            const before = JSON.stringify(counts(bot));
            await approach(block, 2);
            if (block.position.y < Math.floor(bot.entity.position.y) ||
                block.position.y > Math.floor(bot.entity.position.y) + 1 ||
                (Math.abs(block.position.x - bot.entity.position.x) < 1 &&
                 Math.abs(block.position.z - bot.entity.position.z) < 1)) continue;
            const above = bot.blockAt(block.position.offset(0, 1, 0));
            if (!above || /sand|gravel|concrete_powder/.test(above.name)) continue;
            if (!safeBlock(block) || !digging.safeToBreak(block)) continue;
            await bot.tool.equipForBlock(block);
            check();
            if (!block.canHarvest(bot.heldItem?.type ?? null)) continue;
            await bot.dig(block);
            check();
            await approach(block, 0.5);
            await new Promise(resolve => setTimeout(resolve, 500));
            check();
            if (JSON.stringify(counts(bot)) === before) throw new Error('Could not collect nearby materials');
            return;
        }
        throw new Error(`No safe nearby ${names.includes('stone') ? 'stone materials' : 'wood'}`);
    }

    let table = null;
    async function craft(name) {
        check();
        const id = bot.registry.itemsByName[name]?.id;
        const recipe = id === undefined ? null : bot.recipesFor(id, null, 1, table)[0];
        if (!recipe) throw new Error(`Missing materials or recipe for ${name}`);
        if (table) await approach(table, 3);
        await bot.craft(recipe, 1, table);
        check();
    }

    async function planks(required) {
        for (let attempts = 0; attempts < 4; attempts++) {
            const inventory = counts(bot);
            if (Object.entries(inventory).reduce((n, [name, count]) =>
                n + (name.endsWith('_planks') ? count : 0), 0) >= required) return;
            const log = Object.keys(inventory).find(name => /(_log|_stem)$/.test(name));
            if (log) await craft(log.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks'));
            else await gather(Object.keys(bot.registry.blocksByName).filter(name => /(_log|_stem)$/.test(name)));
        }
        throw new Error('Nearby wood limit reached');
    }

    async function sticks(required) {
        while ((counts(bot).stick || 0) < required) {
            await planks(2);
            await craft('stick');
        }
    }

    if (!missingTools(bot).length) return;
    check();
    const feetBlock = bot.blockAt(bot.entity.position.floored());
    const floorBlock = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
    if (bot.entity.isInLava || !floorBlock || floorBlock.boundingBox !== 'block' ||
        FLOOR_HAZARDS.has(floorBlock.name) || FLOOR_HAZARDS.has(feetBlock?.name) ||
        isNextToLava(movements, bot.entity.position))
        throw new Error('Unsafe position for upkeep');
    table = nearby(['crafting_table'])[0] || null;
    if (!table) {
        if (!counts(bot).crafting_table) {
            await planks(4);
            await craft('crafting_table');
        }
        const feet = bot.entity.position.floored();
        let support = null;
        for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const floor = bot.blockAt(feet.offset(x, -1, z));
            const space = bot.blockAt(feet.offset(x, 0, z));
            if (safeBlock(floor) && floor.boundingBox === 'block' && space?.name === 'air') {
                support = floor;
                break;
            }
        }
        if (!support) throw new Error('No safe nearby crafting-table space');
        await bot.equip(bot.inventory.items().find(item => item.name === 'crafting_table'), 'hand');
        check();
        await bot.placeBlock(support, support.position.offset(0, 1, 0).minus(support.position));
        check();
        table = bot.blockAt(support.position.offset(0, 1, 0));
        if (table?.name !== 'crafting_table') throw new Error('Crafting table placement failed');
    }
    const hasMiningTool = bot.inventory.items().some(item =>
        ['wooden', 'golden', ...TIERS].some(tier => item.name === `${tier}_pickaxe`));
    const rockNeeded = missingTools(bot).reduce((n, tool) => n + (tool === 'sword' ? 2 : 3), 0);
    const rockAvailable = ['cobblestone', 'blackstone', 'cobbled_deepslate']
        .reduce((n, name) => n + (counts(bot)[name] || 0), 0);
    if (!hasMiningTool && rockAvailable < rockNeeded) {
        await sticks(2);
        await planks(3);
        await craft('wooden_pickaxe');
    }
    for (const tool of missingTools(bot)) {
        await sticks(tool === 'sword' ? 1 : 2);
        const name = `stone_${tool}`;
        for (let attempts = 0; !bot.recipesFor(bot.registry.itemsByName[name].id, null, 1, table).length; attempts++) {
            if (attempts >= 5) throw new Error('Nearby stone limit reached');
            await gather(ROCKS);
        }
        await craft(name);
    }
    if (missingTools(bot).length) throw new Error('Crafted tools not found in inventory');
}
