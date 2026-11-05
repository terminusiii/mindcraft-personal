import pf from 'mineflayer-pathfinder';

// Shared, hazard-aware pathfinder configuration. Every Movements object used for routing
// should come from safeMovements() so lava and magma are handled consistently.

export const FLOOR_HAZARDS = new Set(['lava', 'magma_block', 'fire', 'soul_fire', 'campfire', 'soul_campfire']);
export const BODY_HAZARDS = new Set(['lava', 'fire', 'soul_fire']);
export const ADJACENT_LAVA_COST = 20;
const LAVA_NEARBY_RANGE = 16;

const nameAt = (movements, pos, dx, dy, dz) => movements.getBlock(pos, dx, dy, dz)?.name;

export function isHazardousMove(movements, from, to) {
    /**
     * A move is hazardous if the destination puts feet or head in lava/fire, stands on lava, magma or fire,
     * jumps over lava, magma or fire (parkour), or cuts a diagonal corner past lava.
     **/
    if (BODY_HAZARDS.has(nameAt(movements, to, 0, 0, 0)) || BODY_HAZARDS.has(nameAt(movements, to, 0, 1, 0))) return true;
    if (FLOOR_HAZARDS.has(nameAt(movements, to, 0, -1, 0))) return true;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const steps = Math.max(Math.abs(dx), Math.abs(dz));
    if (steps > 1) {
        const top = Math.max(from.y, to.y);
        for (let i = 1; i < steps; i++) {
            const p = { x: from.x + Math.round(dx * i / steps), y: top, z: from.z + Math.round(dz * i / steps) };
            for (let dy = -6; dy <= 1; dy++)
                if (FLOOR_HAZARDS.has(nameAt(movements, p, 0, dy, 0))) return true;
        }
    }
    if (Math.abs(dx) === 1 && Math.abs(dz) === 1) {
        for (const [cx, cz] of [[dx, 0], [0, dz]])
            for (const dy of [-1, 0, 1])
                if (nameAt(movements, from, cx, dy, cz) === 'lava') return true;
    }
    return false;
}

export function isNextToLava(movements, pos) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
        for (const dy of [-1, 0, 1])
            if (nameAt(movements, pos, dx, dy, dz) === 'lava') return true;
    return false;
}

export function safeMovements(bot, movements=new pf.Movements(bot)) {
    /**
     * Make pathfinder movements hazard-aware. Lava and magma are never path nodes or floors,
     * parkour cannot jump over them, nodes beside lava cost extra, and blocks next to liquids
     * are never broken (dontCreateFlow is forced on). Parkour and sprinting are disabled in the
     * Nether or when lava is nearby. If the bot is already in lava, moves are not filtered so it can escape.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Movements} movements, movements to adjust. Defaults to new movements.
     * @returns {Movements} the adjusted movements.
     **/
    if (movements.hazardSafe) return movements;
    movements.hazardSafe = true;
    Object.defineProperty(movements, 'dontCreateFlow', { get: () => true, set: () => {}, configurable: true });

    const lavaId = bot.registry?.blocksByName?.lava?.id;
    const inNether = String(bot.game?.dimension ?? '').includes('nether');
    const lavaNearby = lavaId !== undefined && bot.entity && typeof bot.findBlocks === 'function' &&
        bot.findBlocks({ matching: lavaId, maxDistance: LAVA_NEARBY_RANGE, count: 1 }).length > 0;
    if (inNether || lavaNearby) {
        movements.allowParkour = false;
        movements.allowSprinting = false;
    }

    if (typeof movements.getNeighbors === 'function') {
        const baseNeighbors = movements.getNeighbors.bind(movements);
        movements.getNeighbors = node => {
            const moves = baseNeighbors(node);
            if (bot.entity?.isInLava) return moves;
            const safe = [];
            for (const move of moves) {
                if (isHazardousMove(movements, node, move)) continue;
                if (isNextToLava(movements, move)) move.cost += ADJACENT_LAVA_COST;
                safe.push(move);
            }
            return safe;
        };
    }
    return movements;
}

export function applyDefaultSafeMovements(bot) {
    /**
     * Replace plugin default movements (pathfinder, pvp, collectblock) with hazard-aware ones.
     * Call after spawn so the registry and dimension are known.
     **/
    if (bot.pathfinder) bot.pathfinder.setMovements(safeMovements(bot));
    if (bot.pvp) bot.pvp.movements = safeMovements(bot);
    if (bot.collectBlock) bot.collectBlock.movements = safeMovements(bot);
}
