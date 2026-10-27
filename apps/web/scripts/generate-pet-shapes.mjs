/**
 * Original Pizza silhouettes. Bake soft volumes into a few vector layers once;
 * the app animates those layers without a GPU renderer or downloaded assets.
 *
 * Run: node apps/web/scripts/generate-pet-shapes.mjs
 * DS-Bot's offline-volume / runtime-vector split informed this approach; the
 * models, projection, tracing implementation and resulting paths here are ours.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const norm = (p) => {
	const n = Math.hypot(...p) || 1;
	return p.map((x) => x / n);
};
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const smooth = (a, b, k = 0.12) => {
	const h = Math.max(k - Math.abs(a - b), 0) / k;
	return Math.min(a, b) - (h * h * k) / 4;
};
const ellipsoid = (p, c, r) => {
	const q = p.map((v, i) => (v - c[i]) / r[i]);
	const a = Math.hypot(...q),
		b = Math.hypot(...q.map((v, i) => v / r[i]));
	return b < 1e-8 ? -Math.min(...r) : (a * (a - 1)) / b;
};
function segment(p, a, b, r) {
	const v = p.map((n, i) => n - a[i]),
		d = b.map((n, i) => n - a[i]);
	const t = clamp(dot(v, d) / dot(d, d), 0, 1);
	return Math.hypot(...v.map((n, i) => n - d[i] * t)) - r;
}
function polygon(x, y, points) {
	let distance = Infinity,
		inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const [ax, ay] = points[j],
			[bx, by] = points[i],
			dx = bx - ax,
			dy = by - ay;
		const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
		distance = Math.min(distance, Math.hypot(x - ax - t * dx, y - ay - t * dy));
		if (ay > y !== by > y && x < ax + ((y - ay) * dx) / dy) inside = !inside;
	}
	return inside ? -distance : distance;
}
function slab(p, points, depth, radius) {
	const a = polygon(p[0], p[1], points),
		b = Math.abs(p[2]) - depth;
	return Math.min(Math.max(a, b), 0) + Math.hypot(Math.max(0, a), Math.max(0, b)) - radius;
}
const triangle = [
	[-0.74, 0.48],
	[0.64, 0.52],
	[0.04, -0.5],
];
const basil = [
	[0.03, 0.72],
	[0.42, 0.22],
	[0.35, -0.33],
	[-0.04, -0.62],
	[-0.44, -0.19],
	[-0.34, 0.32],
];
const MODELS = {
	pip: {
		color: "#FF9024",
		eye: "#3a2114",
		cheek: "#ff5d6c",
		eyes: [
			[-0.21, -0.02],
			[0.21, -0.02],
		],
		sdf(p) {
			const body = slab(p, triangle, 0.22, 0.3);
			const crust = Math.min(
				segment(p, [-0.75, 0.59, 0.055], [-0.08, 0.69, 0.08], 0.16),
				segment(p, [-0.08, 0.69, 0.08], [0.65, 0.61, 0.04], 0.16),
			);
			return smooth(body, crust, 0.11);
		},
		paints: [
			{ color: "#E7AD63", test: (p) => p[1] > 0.5 },
			{ color: "#CE9149", test: (p) => p[1] > 0.46 && p[1] < 0.6 && p[2] > 0.1 },
			{ color: "#C74B35", test: (p) => (p[0] - 0.37) ** 2 + (p[1] - 0.25) ** 2 < 0.115 ** 2 && p[2] > 0.15 },
		],
	},
	mozz: {
		color: "#F0C975",
		eye: "#4a2e17",
		cheek: "#ff8b7b",
		eyes: [
			[-0.19, -0.02],
			[0.21, -0.02],
		],
		sdf(p) {
			let d = ellipsoid(p, [0, -0.17, 0], [0.59, 0.6, 0.49]);
			d = smooth(d, ellipsoid(p, [0.08, 0.33, 0], [0.29, 0.42, 0.3]), 0.2);
			d = smooth(d, segment(p, [0.08, 0.59, 0], [0.24, 0.81, 0], 0.1), 0.11);
			d = smooth(d, segment(p, [0.24, 0.81, 0], [0.37, 0.74, 0], 0.1), 0.08);
			return d;
		},
		paints: [],
	},
	pomo: {
		color: "#EE4D43",
		eye: "#3b1411",
		cheek: "#ffb1a3",
		eyes: [
			[-0.21, -0.05],
			[0.21, -0.05],
		],
		sdf(p) {
			let d = ellipsoid(p, [0, -0.07, 0], [0.7, 0.65, 0.6]);
			d = smooth(d, ellipsoid(p, [-0.2, 0.58, 0.06], [0.25, 0.09, 0.14]), 0.05);
			d = smooth(d, ellipsoid(p, [0.16, 0.58, 0.05], [0.24, 0.09, 0.13]), 0.05);
			return smooth(d, segment(p, [0, 0.48, 0], [0.09, 0.79, 0], 0.057), 0.045);
		},
		paints: [{ color: "#3F9B59", test: (p) => p[1] > 0.52 }],
	},
	basi: {
		color: "#49AF69",
		eye: "#163821",
		cheek: "#ff8f8f",
		eyes: [
			[-0.21, -0.05],
			[0.21, -0.05],
		],
		sdf: (p) => slab(p, basil, 0.18, 0.3),
		paints: [{ color: "#399653", test: (p) => p[0] < -0.06 && p[2] > 0.12 }],
	},
};

// A restrained three-quarter angle: enough thickness, without hiding the face.
const yaw = (28 * Math.PI) / 180,
	pitch = (11 * Math.PI) / 180,
	roll = (-8 * Math.PI) / 180;
function project(p) {
	const a = [Math.cos(yaw) * p[0] + Math.sin(yaw) * p[2], p[1], -Math.sin(yaw) * p[0] + Math.cos(yaw) * p[2]];
	const b = [a[0], Math.cos(pitch) * a[1] - Math.sin(pitch) * a[2], Math.sin(pitch) * a[1] + Math.cos(pitch) * a[2]];
	return [Math.cos(roll) * b[0] - Math.sin(roll) * b[1], Math.sin(roll) * b[0] + Math.cos(roll) * b[1], b[2]];
}
function unproject(p) {
	const a = [Math.cos(roll) * p[0] + Math.sin(roll) * p[1], -Math.sin(roll) * p[0] + Math.cos(roll) * p[1], p[2]];
	const b = [a[0], Math.cos(pitch) * a[1] + Math.sin(pitch) * a[2], -Math.sin(pitch) * a[1] + Math.cos(pitch) * a[2]];
	return [Math.cos(yaw) * b[0] - Math.sin(yaw) * b[2], b[1], Math.sin(yaw) * b[0] + Math.cos(yaw) * b[2]];
}
function normal(sdf, p) {
	const e = 0.002;
	return norm(
		p.map((_, i) => {
			const a = [...p],
				b = [...p];
			a[i] += e;
			b[i] -= e;
			return sdf(a) - sdf(b);
		}),
	);
}
function ray(sdf, x, y) {
	let z = 1.8;
	for (let i = 0; i < 100 && z > -1.8; i++) {
		const p = unproject([x, y, z]),
			d = sdf(p);
		if (d < 0.001) return { p, n: project(normal(sdf, p)) };
		z -= Math.max(0.002, d * 0.85);
	}
	return null;
}

// Join the half-pixel outlines of a sampled layer, then simplify each ring.
function contours(field, n) {
	const edges = [],
		at = (x, y) => field[y * (n + 1) + x];
	const table = {
		1: [[3, 0]],
		2: [[0, 1]],
		3: [[3, 1]],
		4: [[1, 2]],
		5: [
			[3, 0],
			[1, 2],
		],
		6: [[0, 2]],
		7: [[3, 2]],
		8: [[2, 3]],
		9: [[0, 2]],
		10: [
			[0, 1],
			[2, 3],
		],
		11: [[1, 2]],
		12: [[1, 3]],
		13: [[0, 1]],
		14: [[3, 0]],
	};
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++) {
			const code = (at(x, y) ? 1 : 0) | (at(x + 1, y) ? 2 : 0) | (at(x + 1, y + 1) ? 4 : 0) | (at(x, y + 1) ? 8 : 0);
			const p = [
				[x + 0.5, y],
				[x + 1, y + 0.5],
				[x + 0.5, y + 1],
				[x, y + 0.5],
			];
			for (const [a, b] of table[code] ?? []) edges.push([p[a], p[b]]);
		}
	const key = (p) => `${p[0]},${p[1]}`,
		links = new Map();
	edges.forEach((e, i) =>
		e.forEach((p) => {
			const k = key(p);
			if (!links.has(k)) links.set(k, []);
			links.get(k).push(i);
		}),
	);
	const used = new Set(),
		rings = [];
	for (let i = 0; i < edges.length; i++) {
		if (used.has(i)) continue;
		let index = i,
			point = edges[i][0];
		const ring = [point];
		for (;;) {
			used.add(index);
			const edge = edges[index];
			point = key(edge[0]) === key(point) ? edge[1] : edge[0];
			ring.push(point);
			const next = links.get(key(point)).find((j) => !used.has(j));
			if (next === undefined) break;
			index = next;
		}
		if (ring.length > 12) rings.push(ring);
	}
	return rings;
}
function simplify(points, epsilon) {
	if (points.length < 3) return points;
	const a = points[0],
		b = points.at(-1);
	let best = epsilon,
		index = -1;
	for (let i = 1; i < points.length - 1; i++) {
		const p = points[i],
			dx = b[0] - a[0],
			dy = b[1] - a[1],
			t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
		const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
		if (d > best) {
			best = d;
			index = i;
		}
	}
	return index < 0
		? [a, b]
		: [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)];
}
function bake(model) {
	const n = 240,
		extent = 1.35,
		length = (n + 1) ** 2;
	const body = new Uint8Array(length),
		shade = new Uint8Array(length),
		light = new Uint8Array(length),
		paints = model.paints.map(() => new Uint8Array(length));
	const lamp = norm([-0.65, 0.7, 1.05]);
	for (let y = 0; y <= n; y++)
		for (let x = 0; x <= n; x++) {
			const hit = ray(model.sdf, -extent + (x * extent * 2) / n, extent - (y * extent * 2) / n);
			if (!hit) continue;
			const i = y * (n + 1) + x,
				illumination = dot(hit.n, lamp);
			body[i] = 1;
			shade[i] = Number(illumination < 0.12);
			light[i] = Number(illumination > 0.9);
			model.paints.forEach((paint, j) => {
				paints[j][i] = Number(paint.test(hit.p));
			});
		}
	const rings = contours(body, n),
		all = rings.flat(),
		xs = all.map((p) => p[0]),
		ys = all.map((p) => p[1]);
	const left = Math.min(...xs),
		right = Math.max(...xs),
		top = Math.min(...ys),
		bottom = Math.max(...ys);
	const scale = 80 / Math.max(right - left, bottom - top),
		center = [(left + right) / 2, (top + bottom) / 2];
	const place = (p) => [56 + (p[0] - center[0]) * scale, 56 + (p[1] - center[1]) * scale];
	const toPath = (loops) =>
		loops
			.map((ring) => {
				const points = ring.map(place),
					half = Math.floor(points.length / 2);
				const simple = [
					...simplify(points.slice(0, half + 1), 0.55).slice(0, -1),
					...simplify(points.slice(half), 0.55),
				].slice(0, -1);
				const fmt = (p) => p.map((x) => Number(x.toFixed(2))).join(",");
				// Quadratic corner smoothing stays inside each ring's hull. Unbounded
				// cubic tangents overshoot where a tiny corner meets a long straight edge.
				const midpoint = (a, b) => a.map((x, i) => (x + b[i]) / 2);
				return (
					"M" +
					fmt(midpoint(simple.at(-1), simple[0])) +
					simple.map((p, i) => "Q" + fmt(p) + " " + fmt(midpoint(p, simple[(i + 1) % simple.length]))).join("") +
					"Z"
				);
			})
			.join("");
	const eyes = model.eyes.map(([x, y]) => {
		let z = 1.5;
		for (let i = 0; i < 80; i++) {
			const d = model.sdf([x, y, z]);
			if (d < 0.0005) break;
			z -= Math.max(0.001, d * 0.85);
		}
		const p = project([x, y, z]),
			base = project([x, y - 0.1, z]),
			face = project(normal(model.sdf, [x, y, z]));
		const [cx, cy] = place([((p[0] + extent) * n) / (2 * extent), ((extent - p[1]) * n) / (2 * extent)]);
		return {
			x: +cx.toFixed(2),
			y: +cy.toFixed(2),
			width: +(12.6 * clamp(face[2], 0.74, 1)).toFixed(2),
			height: 15,
			tilt: +((Math.atan2(base[0] - p[0], p[1] - base[1]) * 180) / Math.PI).toFixed(2),
		};
	});
	return {
		color: model.color,
		eye: model.eye,
		cheek: model.cheek,
		body: toPath(rings),
		shade: toPath(contours(shade, n)),
		light: toPath(contours(light, n)),
		paints: model.paints.map((p, i) => ({ color: p.color, path: toPath(contours(paints[i], n)) })),
		eyes,
	};
}
export const shapes = Object.fromEntries(Object.entries(MODELS).map(([id, model]) => [id, bake(model)]));
const file = fileURLToPath(new URL("../src/components/pet-shapes.ts", import.meta.url));
const source = `// Generated by scripts/generate-pet-shapes.mjs. Original Pizza character art.\nexport interface PetEye { x:number; y:number; width:number; height:number; tilt:number }\nexport interface PetShape { color:string; eye:string; cheek:string; body:string; shade:string; light:string; paints:{color:string;path:string}[]; eyes:PetEye[] }\nexport const PET_SHAPES:Record<string,PetShape> = ${JSON.stringify(shapes, null, 2)};\n`;
for (const [id, shape] of Object.entries(shapes)) {
 if (shape.eyes.length !== 2 || !shape.body || !shape.shade || /NaN|Infinity/.test(JSON.stringify(shape))) throw new Error(`Invalid pet geometry: ${id}`);
 for (const eye of shape.eyes) if (eye.x < 16 || eye.x > 96 || eye.y < 16 || eye.y > 96 || eye.width <= 0 || eye.height <= 0) throw new Error(`Invalid eye placement: ${id}`);
}
if (process.argv.includes('--check')) {
 if (readFileSync(file,'utf8') !== source) throw new Error('Pet art is stale. Run npm run pets:bake in apps/web.');
 console.log('All four vector pets reproduce exactly; geometry and eye placements are valid.');
} else {
 writeFileSync(file, source);
 console.log(`Baked ${Object.keys(shapes).join(', ')} → ${file}`);
}
