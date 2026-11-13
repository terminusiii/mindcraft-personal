import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE_PATH = fileURLToPath(new URL('../../data/waypoints.geojson', import.meta.url));
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 50;

export class MemoryBank {
	constructor(filePath = DEFAULT_FILE_PATH) {
		this.filePath = path.resolve(filePath);
		this.lockPath = `${this.filePath}.lock`;
	}

	async rememberPlace(name, x, y, z, dimension) {
		const cleanName = typeof name === 'string' ? name.trim() : '';
		if (!cleanName) throw new Error('Waypoint name must not be empty.');
		if (![x, y, z].every(Number.isFinite)) throw new Error('Waypoint coordinates must be finite numbers.');
		if (typeof dimension !== 'string' || !dimension) throw new Error('Waypoint dimension must not be empty.');

		await this.withLock(async () => {
			const places = await this.readPlaces();
			const updatedPlaces = places.filter(place => place.name !== cleanName);
			updatedPlaces.push({ name: cleanName, x, y, z, dimension });
			await this.writePlaces(updatedPlaces);
		});
	}

	async recallPlace(name) {
		const places = await this.readPlaces();
		return places.find(place => place.name === name);
	}

	getPlaces() {
		return this.readPlaces();
	}

	async getKeys() {
		return (await this.getPlaces()).map(place => place.name).join(', ');
	}

	async readPlaces() {
		let contents;
		try {
			contents = await readFile(this.filePath, 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT') return [];
			throw error;
		}

		let collection;
		try {
			collection = JSON.parse(contents);
		} catch (error) {
			throw new Error(`Could not parse waypoint GeoJSON at ${this.filePath}: ${error.message}`, { cause: error });
		}
		if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
			throw new Error(`Waypoint file ${this.filePath} must contain a GeoJSON FeatureCollection.`);
		}

		return collection.features.map((feature, index) => {
			const { name, dimension, y } = feature.properties ?? {};
			const coordinates = feature.geometry?.coordinates;
			if (feature.type !== 'Feature' || feature.geometry?.type !== 'Point' ||
				!Array.isArray(coordinates) || coordinates.length < 2 ||
				typeof name !== 'string' || !name ||
				typeof dimension !== 'string' || !dimension ||
				![coordinates[0], y, coordinates[1]].every(Number.isFinite)) {
				throw new Error(`Waypoint feature ${index} in ${this.filePath} is invalid.`);
			}
			return { name, dimension, x: coordinates[0], y, z: coordinates[1] };
		});
	}

	async writePlaces(places) {
		const collection = {
			type: 'FeatureCollection',
			features: places.map(({ name, dimension, x, y, z }) => ({
				type: 'Feature',
				properties: { name, dimension, y },
				geometry: { type: 'Point', coordinates: [x, z] }
			}))
		};
		const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
			await rename(temporaryPath, this.filePath);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	async withLock(operation) {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const deadline = Date.now() + LOCK_TIMEOUT_MS;

		while (true) {
			try {
				await mkdir(this.lockPath);
				try {
					await writeFile(path.join(this.lockPath, 'owner.json'), JSON.stringify({
						pid: process.pid,
						token: randomUUID()
					}));
				} catch (error) {
					await rm(this.lockPath, { recursive: true, force: true });
					throw error;
				}
				break;
			} catch (error) {
				if (error.code !== 'EEXIST') throw error;
				await this.removeStaleLock();
				if (Date.now() >= deadline) {
					throw new Error(`Timed out waiting for waypoint file lock ${this.lockPath}.`);
				}
				await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
			}
		}

		try {
			return await operation();
		} finally {
			await rm(this.lockPath, { recursive: true, force: true });
		}
	}

	async removeStaleLock() {
		try {
			const lockStats = await stat(this.lockPath);
			if (Date.now() - lockStats.mtimeMs < LOCK_STALE_MS) return;

			let owner;
			try {
				owner = JSON.parse(await readFile(path.join(this.lockPath, 'owner.json'), 'utf8'));
			} catch (error) {
				if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
			}
			if (owner?.pid) {
				try {
					process.kill(owner.pid, 0);
					return;
				} catch (error) {
					if (error.code !== 'ESRCH') throw error;
				}
			}

			const stalePath = `${this.lockPath}.stale-${randomUUID()}`;
			try {
				await rename(this.lockPath, stalePath);
				await rm(stalePath, { recursive: true, force: true });
			} catch (error) {
				if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
			}
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
}
