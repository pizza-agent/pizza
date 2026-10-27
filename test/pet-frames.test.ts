import { describe, expect, it } from "vitest";
import { mergePetFrames, type PetSnapshot, type PetStatus } from "../apps/web/src/lib/pet";

const status = (over: Partial<PetStatus> = {}): PetStatus => ({
	name: "Mochi", speciesId: "dog", xp: 40, level: 3, mood: "idle", busy: false,
	scale: 1, adoptedAt: 1, floating: null, ...over,
});
const frame = (pet: PetStatus | null, at: number) => ({ snapshot: { pet, species: null } as PetSnapshot, at });

describe("pet frames from several workspace sidecars", () => {
	it("takes identity from the newest frame", () => {
		const merged = mergePetFrames(new Map([
			["/a", frame(status({ speciesId: "cat", name: "Old" }), 1)],
			["/b", frame(status({ speciesId: "dog", name: "New", mood: "happy" }), 2)],
		]), 3);
		expect(merged?.pet).toMatchObject({ speciesId: "dog", name: "New", mood: "happy", busy: false });
	});

	it("works while any workspace is busy, until that flag goes stale", () => {
		const frames = new Map([
			["/a", frame(status({ busy: true, mood: "working" }), 1_000)],
			["/b", frame(status({ mood: "sleepy" }), 2_000)],
		]);
		expect(mergePetFrames(frames, 3_000)?.pet).toMatchObject({ busy: true, mood: "working" });
		expect(mergePetFrames(frames, 10 * 60_000)?.pet).toMatchObject({ busy: false, mood: "sleepy" });
	});

	it("a release wins over older frames", () => {
		const merged = mergePetFrames(new Map([
			["/a", frame(status({ busy: true }), 1)],
			["/b", frame(null, 2)],
		]), 3);
		expect(merged?.pet).toBeNull();
	});
});


describe("ordered pet appearance updates", () => {
 it("keeps a newer selection even when an old workspace frame arrives later", () => {
  const selected={snapshot:{pet:status({speciesId:"pip"}),species:null,revision:200},at:10};
  const delayed={snapshot:{pet:status({speciesId:"mozz"}),species:null,revision:100},at:20};
  expect(mergePetFrames(new Map([["rpc",selected],["old",delayed]]))?.pet?.speciesId).toBe("pip");
 });
 it("does not resurrect a released pet from an in-flight frame", () => {
  const released={snapshot:{pet:null,species:null,revision:300},at:10};
  const delayed={snapshot:{pet:status(),species:null,revision:200},at:20};
  expect(mergePetFrames(new Map([["rpc",released],["old",delayed]]))?.pet).toBeNull();
 });
});
