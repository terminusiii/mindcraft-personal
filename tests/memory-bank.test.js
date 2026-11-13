import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryBank } from '../src/agent/memory_bank.js';

test('waypoints persist as dimension-aware GeoJSON and are shared between instances', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-waypoints-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const filePath = path.join(directory, 'waypoints.geojson');
	const firstBank = new MemoryBank(filePath);
	const secondBank = new MemoryBank(filePath);

	await Promise.all([
		firstBank.rememberPlace('base', 10.5, 64, -20.25, 'overworld'),
		secondBank.rememberPlace('fortress', 3, 70, 8, 'the_nether')
	]);

	assert.deepEqual(
		(await firstBank.getPlaces()).map(({ name, dimension }) => ({ name, dimension })).sort((a, b) => a.name.localeCompare(b.name)),
		[
			{ name: 'base', dimension: 'overworld' },
			{ name: 'fortress', dimension: 'the_nether' }
		]
	);
	assert.deepEqual(await secondBank.recallPlace('base'), {
		name: 'base',
		dimension: 'overworld',
		x: 10.5,
		y: 64,
		z: -20.25
	});

	const collection = JSON.parse(await readFile(filePath, 'utf8'));
	assert.equal(collection.type, 'FeatureCollection');
	assert.ok(collection.features.some(feature =>
		feature.properties.name === 'fortress' &&
		feature.properties.dimension === 'the_nether' &&
		feature.properties.y === 70 &&
		feature.geometry.coordinates[0] === 3 &&
		feature.geometry.coordinates[1] === 8
	));
});

test('saving an existing waypoint name replaces it', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-waypoints-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const bank = new MemoryBank(path.join(directory, 'waypoints.geojson'));

	await bank.rememberPlace('base', 1, 2, 3, 'overworld');
	await bank.rememberPlace('base', 4, 5, 6, 'the_end');

	assert.deepEqual(await bank.getPlaces(), [{
		name: 'base',
		dimension: 'the_end',
		x: 4,
		y: 5,
		z: 6
	}]);
});
