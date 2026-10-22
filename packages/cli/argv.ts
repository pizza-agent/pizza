/** Node's eval/print entry points have no script path in argv[1]. */
export function cliArguments(argv: string[], execArgv: string[]): string[] {
	const evaluated = execArgv.some((arg) =>
		arg === "-e" || arg === "--eval" || arg.startsWith("--eval=") ||
		arg === "-p" || arg === "--print" || arg.startsWith("--print="),
	);
	return argv.slice(evaluated ? 1 : 2);
}
