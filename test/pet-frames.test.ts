import { describe, expect, it } from "vitest";
import { mergePetFrames, type PetSnapshot, type PetStatus } from "../apps/web/src/lib/pet-frames";

const status = (over: Partial<PetStatus> = {}): PetStatus => ({
	speciesId: "pizza", xp: 40, level: 3, mood: "idle", busy: false,
	scale: 1, adoptedAt: 1, floating: null, ...over,
});
const frame = (pet: PetStatus | null, at: number) => ({ snapshot: { pet, activity: { mood: pet?.mood ?? "idle", busy: pet?.busy ?? false } } as PetSnapshot, at });

describe("pet frames from several workspace sidecars", () => {
	it("takes identity from the newest frame", () => {
		const merged = mergePetFrames(new Map([
			["/a", frame(status({ speciesId: "pizza" }), 1)],
			["/b", frame(status({ speciesId: "pizza", mood: "happy" }), 2)],
		]), 3);
		expect(merged?.pet).toMatchObject({ speciesId: "pizza", mood: "happy", busy: false });
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
 it("keeps newer appearance settings when an old workspace frame arrives later", () => {
  const selected={snapshot:{activity:{mood:"idle" as const,busy:false},pet:status({scale:1.3}),revision:200},at:10};
  const delayed={snapshot:{activity:{mood:"idle" as const,busy:false},pet:status({scale:.8}),revision:100},at:20};
  expect(mergePetFrames(new Map([["rpc",selected],["old",delayed]]))?.pet?.scale).toBe(1.3);
 });
 it("does not resurrect a released pet from an in-flight frame", () => {
  const released={snapshot:{activity:{mood:"idle" as const,busy:false},pet:null,revision:300},at:10};
  const delayed={snapshot:{activity:{mood:"idle" as const,busy:false},pet:status(),revision:200},at:20};
  expect(mergePetFrames(new Map([["rpc",released],["old",delayed]]))?.pet).toBeNull();
 });
});

describe("expression frames", () => {
 it("keeps a specific working expression across an idle identity update", () => {
  const merged=mergePetFrames(new Map([
   ["active",frame(status({busy:true,mood:"speaking"}),1000)],
   ["identity",frame(status({mood:"idle"}),2000)],
  ]),3000);
  expect(merged?.pet).toMatchObject({busy:true,mood:"speaking"});
 });
 it("prioritizes waiting and retains activity without an adopted pet", () => {
  const merged=mergePetFrames(new Map([
   ["active",{snapshot:{pet:null,activity:{mood:"working",busy:true}} as PetSnapshot,at:1000}],
   ["waiting",{snapshot:{pet:null,activity:{mood:"waiting",busy:true}} as PetSnapshot,at:2000}],
  ]),3000);
  expect(merged).toMatchObject({pet:null,activity:{mood:"waiting",busy:true}});
 });
 it("stops animating a stale sidecar's expression", () => {
  const merged=mergePetFrames(new Map([
   ["dead",{snapshot:{pet:status({busy:true,mood:"thinking"}),activity:{mood:"thinking",busy:true}} as PetSnapshot,at:1000}],
  ]),10*60_000);
  expect(merged?.activity).toEqual({busy:false,mood:"idle"});
 });
});
