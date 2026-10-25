/**
 * Scheduler public API. Re-exports the types and helpers needed by:
 *   - packages/rpc/rpc-mode.ts (engine + dispatcher)
 *   - src/core/session-facade-factory.ts (assembly)
 *   - apps/web (transitively, via transport.ts and types.ts)
 *
 * Internal modules are intentionally NOT re-exported to keep the surface
 * small. Add new entries here as the API grows.
 */

export {
	SchedulerEngine,
	nextRunAt,
	nextNRuns,
	type Dispatcher,
	type SchedulerEngineOptions,
	type SchedulerEngineEvents,
	type SchedulerListener,
} from "./engine.js";

export {
	parseCron,
	validateCron,
	specToCron,
	cronToSpec,
	cronNextRun,
} from "./cron.js";

export {
	detectScheduleIntent,
	DeterministicPatternDetector,
	type DetectedScheduleIntent,
	type ScheduleIntentDetector,
} from "./intent-detect.js";

export {
	readTasks,
	writeTasks,
	appendRun,
	readRuns,
	readTaskFresh,
	readTasksAllScopes,
	mutateTaskAnyScope,
	getSchedulerDir,
	getSchedulerDirForTest,
	type ScopedTask,
} from "./store.js";

export { SchedulerScopeLock, HEARTBEAT_MS, STALE_MS } from "./scope-lock.js";

export {
	generateTaskId,
	defaultTaskName,
	validateScheduleSpec,
	SCHEDULE_MIN_INTERVAL_N,
	SCHEDULE_MAX_INTERVAL_N,
	SCHEDULE_NAME_MAX,
} from "./types.js";

export type {
	ScheduledTask,
	ScheduledTaskSummary,
	ScheduledTaskRun,
	ScheduleSpec,
	ScheduleMode,
	TimeOfDay,
	Weekday,
	DayOfMonth,
} from "../../../packages/protocol/index.js";