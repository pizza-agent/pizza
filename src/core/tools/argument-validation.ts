import { Ajv, type ValidateFunction } from "ajv";

// Validate locally even when a provider supports structured tool arguments.
// Do not coerce values or silently drop unknown properties.
const ajv = new Ajv({ strict: false, strictNumbers: true });
const validators = new WeakMap<object, ValidateFunction>();

export function validateToolArguments(schema: object, args: unknown): void {
	let validate = validators.get(schema);
	if (!validate) {
		validate = ajv.compile(schema);
		validators.set(schema, validate);
	}
	if (!validate(args)) {
		throw new Error(`Invalid tool arguments: ${ajv.errorsText(validate.errors)}`);
	}
}
