import { useTranslation } from "react-i18next";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function schemaType(value: unknown): string {
	const schema = record(value);
	if (Array.isArray(schema.enum)) return schema.enum.map((item) => JSON.stringify(item)).join(" | ");
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		if (Array.isArray(schema[key])) return schema[key].map(schemaType).join(key === "allOf" ? " & " : " | ");
	}
	if (schema.type === "array") return `${schemaType(schema.items)}[]`;
	if (Array.isArray(schema.type)) return schema.type.join(" | ");
	if (typeof schema.type === "string") return schema.type;
	if (typeof schema.$ref === "string") return schema.$ref.split("/").pop() ?? schema.$ref;
	return schema.properties ? "object" : "unknown";
}

/** Keep the common parameters readable; retain the full schema for nested inputs. */
export function McpToolParameters({ schema }: { schema?: Record<string, unknown> }) {
	const { t } = useTranslation();
	if (!schema) return <p className="text-xs text-muted">{t("plugins.mcp.schemaUnavailable")}</p>;
	const properties = Object.entries(record(schema.properties));
	const required = Array.isArray(schema.required) ? schema.required : [];
	return (
		<div className="space-y-2 pt-1">
			<h5 className="text-xs font-medium text-fg">{t("plugins.mcp.parameters")}</h5>
			{properties.length ? <div className="divide-y divide-border rounded-lg border border-border">
				{properties.map(([name, value]) => {
					const parameter = record(value);
					return <div key={name} className="space-y-1 px-3 py-2.5">
						<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
							<code className="break-all font-medium text-fg">{name}</code>
							<code className="break-all text-muted">{schemaType(value)}</code>
							<span className={required.includes(name) ? "text-accent" : "text-muted"}>
								{t(required.includes(name) ? "plugins.mcp.required" : "plugins.mcp.optional")}
							</span>
						</div>
						{typeof parameter.description === "string" && <p className="whitespace-pre-wrap break-words text-xs text-muted">{parameter.description}</p>}
						{parameter.default !== undefined && <p className="break-all text-xs text-muted">{t("plugins.mcp.defaultValue")}: <code>{JSON.stringify(parameter.default)}</code></p>}
					</div>;
				})}
			</div> : <p className="text-xs text-muted">{t(Object.keys(schema).some((key) => ["$ref", "anyOf", "oneOf", "allOf", "additionalProperties"].includes(key)) ? "plugins.mcp.seeSchema" : "plugins.mcp.noParameters")}</p>}
			<details className="text-xs text-muted">
				<summary className="cursor-pointer hover:text-fg">{t("plugins.mcp.fullSchema")}</summary>
				<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3">{JSON.stringify(schema, null, 2)}</pre>
			</details>
		</div>
	);
}
